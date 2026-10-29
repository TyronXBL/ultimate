/**
 * GitHub Actions on the fork, shared by the lander's gate (`.ultimate/scripts/ci-gate.ts`) and the `ci` tool: which
 * repository a remote is, the secret scan before a push, and the Actions API, authenticated with the remote's stored
 * Git credential when there is one. The token goes only into the request header: no output, error or log carries it.
 */
import { execFile } from 'node:child_process'
import type { Failure, JobResult } from './refs.ts'

/** The API base; tests point it at a local listener. */
const api = () => process.env.CI_GATE_API ?? 'https://api.github.com'

// The token and key shapes that must never reach the public fork (GitHub, OpenAI, Anthropic, AWS, Slack, Google, keys).
const SECRETS =
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/

export type Run = { id: number; status: string; conclusion: string | null; html_url: string }
type Job = {
  id: number
  name: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
}
type Annotation = {
  path: string
  start_line: number
  title?: string
  message: string
  annotation_level: string
}

/** The GitHub API failed (network, rate limit, outage) after its retries; the message names the last failure. */
export class Unreachable extends Error {}

/** Run git in `cwd`, `input` on its stdin; resolves its stdout, trimmed. */
export function git(cwd: string, args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()),
    )
    // A git that exits before reading its stdin closes the pipe (EPIPE); its exit code and stderr already say why, and
    // an unhandled error here would take the whole server down.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
}

/** `owner/repo` of the GitHub remote `remote` in `cwd`. */
export async function repository(cwd: string, remote: string) {
  const url = await git(cwd, ['remote', 'get-url', remote])
  const match = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/.exec(url)
  if (!match) throw new Error(`${remote} is not a GitHub remote: ${url}`)
  return match[1]
}

/** Commits a push of `sha` to `remote` would publish that look like they carry a secret: `<commit> <file>`, never what. */
export async function secretsIn(cwd: string, sha: string, remote: string) {
  const patch = await git(cwd, [
    'log',
    '-p',
    '--format=commit %H%n%B',
    sha,
    '--not',
    `--remotes=${remote}`,
  ])
  const found: string[] = []
  let commit = ''
  let file = '(message)'
  for (const line of patch.split('\n')) {
    if (line.startsWith('commit ')) [commit, file] = [line.slice(7, 14), '(message)']
    else if (line.startsWith('+++ ')) file = line.slice(6)
    else if ((line.startsWith('+') || file === '(message)') && SECRETS.test(line))
      found.push(`${commit} ${file}`)
  }
  return [...new Set(found)]
}

/**
 * The token Git stores for `repo`, or undefined: asked from Git's credential helpers, which never prompt here. It
 * lifts the API limit from 60 calls an hour (per machine, unauthenticated) to 5000.
 */
async function token(cwd: string, repo: string) {
  const answer = await git(
    cwd,
    ['-c', 'credential.interactive=false', 'credential', 'fill'],
    `protocol=https\nhost=github.com\npath=${repo}.git\n\n`,
  ).catch(
    // No helper has a credential for it (another machine, no fork login): poll unauthenticated.
    () => '',
  )
  return /^password=(.+)$/m.exec(answer)?.[1]
}

/**
 * How often to look at a run: every 20 s with a token; every 60 s without, where two calls a look would otherwise use
 * up the 60 an hour within 15 minutes.
 */
export const pollMs = async (cwd: string, repo: string) =>
  (await token(cwd, repo)) ? 20_000 : 60_000

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** GET `path` of the GitHub API for `repo`, tried `tries` times; throws `Unreachable` naming the last failure. */
async function call<T>(cwd: string, repo: string, path: string, tries = 3): Promise<T> {
  const secret = await token(cwd, repo)
  let failure = ''
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(`${api()}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) return (await response.json()) as T
      failure = `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (attempt < tries) await sleep(10_000)
  }
  throw new Unreachable(`the GitHub API failed ${tries} times on ${path}: ${failure}`)
}

/** The push runs of `sha`, newest first; with `branch`, only those on it. */
export const runsOf = async (
  cwd: string,
  repo: string,
  sha: string,
  branch?: string,
  tries?: number,
) =>
  (
    await call<{ workflow_runs: Run[] }>(
      cwd,
      repo,
      `/repos/${repo}/actions/runs?head_sha=${sha}&event=push${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`,
      tries,
    )
  ).workflow_runs

/** A run as it is now, with its jobs. */
export async function runState(cwd: string, repo: string, id: number) {
  const { jobs } = await call<{ jobs: Job[] }>(cwd, repo, `/repos/${repo}/actions/runs/${id}/jobs`)
  const run = await call<Run>(cwd, repo, `/repos/${repo}/actions/runs/${id}`)
  return { run, jobs }
}

export const jobResult = (job: Job): JobResult => ({
  name: job.name,
  conclusion: job.conclusion ?? 'running',
  ...(job.started_at && job.completed_at
    ? { seconds: Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000) }
    : {}),
})

/** The failing tests of a run's failed jobs, from their annotations (Vitest titles one `file > test`). */
export async function failuresOf(cwd: string, repo: string, jobs: Job[]) {
  const failures: Failure[] = []
  for (const job of jobs.filter(
    (item) => item.conclusion !== 'success' && item.conclusion !== 'skipped',
  )) {
    const notes = await call<Annotation[]>(
      cwd,
      repo,
      `/repos/${repo}/check-runs/${job.id}/annotations`,
    ).catch(
      // The run's conclusion already decides; without annotations the job's own line names it.
      () => [],
    )
    const named = notes.filter(
      (note) => note.annotation_level === 'failure' && note.path !== '.github',
    )
    for (const note of named)
      failures.push({
        title: note.title || `${note.path}:${note.start_line}`,
        message: note.message.split('\n')[0],
      })
    if (!named.length) failures.push({ title: job.name, message: job.conclusion ?? 'failed' })
  }
  return failures
}
