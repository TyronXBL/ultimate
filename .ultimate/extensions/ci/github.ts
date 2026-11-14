/**
 * GitHub Actions on the fork, shared by the lander's gate (`.ultimate/scripts/ci-gate.ts`) and the `ci` tool: which
 * repository a remote is, the secret scan before a push, and the Actions API, authenticated with the remote's stored
 * Git credential when there is one. The token goes only into the request header: no output, error or log carries it.
 */
import { execFile } from 'node:child_process'
import type { Reused } from '../../../extensions/workspaces/api.ts'
import type { CiResult, Failure, JobResult } from './refs.ts'

/** The API base; tests point it at a local listener. */
const api = () => process.env.CI_GATE_API ?? 'https://api.github.com'

// The token and key shapes that must never reach the fork (GitHub, OpenAI, Anthropic, AWS, Slack, Google, keys).
const SECRETS =
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/

export type Run = { id: number; status: string; conclusion: string | null; html_url: string }
export type Job = {
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

/**
 * GitHub gave no verdict on the code: its API failed (network, rate limit, outage) after its retries, or Actions did not
 * start the jobs; the message names why.
 */
export class Unreachable extends Error {}

/**
 * The annotation GitHub itself (path `.github`) puts on a job it refuses to start: "The job was not started because
 * recent account payments have failed or your spending limit needs to be increased…". A private repository on a $0
 * budget gets it once the month's included minutes are spent (#169933); it says nothing about the code.
 */
const notStartedBy = (note: Annotation) =>
  note.path === '.github' && note.message.startsWith('The job was not started because ')

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
  const range = [sha, '--not', `--remotes=${remote}`]
  const found: string[] = []
  // Messages are read apart from the patches, so no message line can pass for a diff header.
  // A NUL starts each record, which no message line can hold.
  for (const record of (await git(cwd, ['log', '--format=%x00%H %B', ...range])).split('\0'))
    if (SECRETS.test(record)) found.push(`${record.slice(0, 7)} (message)`)
  let commit = ''
  // `--cc` adds what a merge's own resolution introduced, which plain `-p` leaves out of merge commits. A combined diff
  // gives each hunk line one prefix column per parent (its hunk header one `@` more than that): a line is added when
  // some column says `+` and none says `-`. Every hunk line starts with such a column, so a hunk ends only at the next
  // `diff ` or `commit ` line, and lines outside hunks (headers, file names) are scanned whole.
  let file = ''
  let columns = 0
  for (const line of (await git(cwd, ['log', '-p', '--cc', '--format=commit %H', ...range])).split(
    '\n',
  )) {
    const hunk = /^(@{2,}) /.exec(line)
    const prefix = line.slice(0, columns)
    if (line.startsWith('commit ')) [commit, file, columns] = [line.slice(7, 14), '', 0]
    else if (line.startsWith('diff ')) columns = 0
    else if (!columns && line.startsWith('+++ ')) file = line.slice(6)
    else if (hunk) columns = hunk[1].length - 1
    else if ((!columns || (prefix.includes('+') && !prefix.includes('-'))) && SECRETS.test(line))
      found.push(`${commit} ${file || '(header)'}`)
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
 * How often to look at a run: every 20 s with a token; every 3 min without, where the 60 calls an hour are shared by
 * every run and landing on the machine.
 */
export const pollMs = async (cwd: string, repo: string) =>
  (await token(cwd, repo)) ? 20_000 : 180_000

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
      const body = await response.text()
      // A body that echoed the request would carry the token: masked before it is cut, so no part of it leaves here.
      failure = `HTTP ${response.status} ${(secret ? body.replaceAll(secret, '***') : body).slice(0, 200)}`
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

/** A run as it is now: one call, for a poll. */
export const runOf = (cwd: string, repo: string, id: number, tries?: number) =>
  call<Run>(cwd, repo, `/repos/${repo}/actions/runs/${id}`, tries)

/** A run as it is now, with its jobs. */
export async function runState(cwd: string, repo: string, id: number, tries?: number) {
  const { jobs } = await call<{ jobs: Job[] }>(
    cwd,
    repo,
    `/repos/${repo}/actions/runs/${id}/jobs`,
    tries,
  )
  return { run: await runOf(cwd, repo, id, tries), jobs }
}

/** How long after GitHub finished it a passed run of a commit stands in for the lander's gate (#205147). */
export const REUSE_MS = 6 * 60 * 60_000

/**
 * What the lander's gate (before any runner, #205147) and the `ci` tool do with the push runs of the commit they check:
 * wait for one still under way (in progress is never passed); run fresh when one ended any other way than passed, so a
 * flaky pass cannot hide a failure of that very commit, or when none ran; else the gate weighs reusing the newest pass
 * (`reusable`) and the tool reports it.
 */
export type GatePlan =
  | { kind: 'wait'; run: Run }
  | { kind: 'fresh'; why: string }
  | { kind: 'reuse'; run: Run }
export function gatePlan(runs: Run[], sha: string): GatePlan {
  const going = runs.find((run) => run.status !== 'completed')
  if (going) return { kind: 'wait', run: going }
  const ended = runs.find((run) => run.conclusion !== 'success')
  if (ended)
    return {
      kind: 'fresh',
      why: `tip CI had ${ended.conclusion === 'failure' ? 'failed' : `ended ${ended.conclusion}`}: ${ended.html_url}`,
    }
  return runs[0]
    ? { kind: 'reuse', run: runs[0] }
    : { kind: 'fresh', why: `no CI run of ${sha.slice(0, 7)}` }
}

/** When the last of `jobs` finished on GitHub and the seconds since the first started, when they carry times. */
function timesOf(jobs: Job[]) {
  const starts = jobs.flatMap((job) => (job.started_at ? [Date.parse(job.started_at)] : []))
  const ends = jobs.flatMap((job) => (job.completed_at ? [Date.parse(job.completed_at)] : []))
  if (!starts.length || !ends.length) return undefined
  const completedAt = Math.max(...ends)
  return { completedAt, seconds: Math.round((completedAt - Math.min(...starts)) / 1000) }
}

/**
 * The origin of passed run `run` of `sha`, from its jobs' times on GitHub, when it finished at most `REUSE_MS` before
 * `now`; else why it runs fresh. A run whose jobs carry no times names no origin and is not reused.
 */
export function reusable(
  run: Run,
  jobs: Job[],
  sha: string,
  now: number,
): { origin: Reused } | { origin?: undefined; why: string } {
  const times = timesOf(jobs)
  if (!times || jobs.some((job) => !job.completed_at))
    return { why: `the pass of ${sha.slice(0, 7)} has no job times: ${run.html_url}` }
  const { completedAt, seconds } = times
  if (now - completedAt > REUSE_MS)
    return {
      why: `the pass of ${sha.slice(0, 7)} is ${+((now - completedAt) / 3_600_000).toFixed(1)} h old: ${run.html_url}`,
    }
  return {
    origin: { runner: 'GitHub Actions', url: run.html_url, sha, completedAt, seconds },
  }
}

export const jobResult = (job: Job): JobResult => ({
  name: job.name,
  conclusion: job.conclusion ?? 'running',
  ...(job.started_at && job.completed_at
    ? { seconds: Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000) }
    : {}),
})

/**
 * The failing tests of a run's failed jobs, from their annotations (Vitest titles one `file > test`). `notStarted` is
 * GitHub's reason when the only failed jobs are ones it did not start (billing): no verdict on the code. A job that ran
 * and failed is a verdict, so its failures win over another job's refusal. Throws `Unreachable` when annotations
 * cannot be read, since a refused job cannot be told from a failed one without them.
 */
async function failuresOf(cwd: string, repo: string, jobs: Job[]) {
  const failures: Failure[] = []
  let notStarted: string | undefined
  for (const job of jobs.filter(
    (item) => item.conclusion !== 'success' && item.conclusion !== 'skipped',
  )) {
    const notes = await call<Annotation[]>(
      cwd,
      repo,
      `/repos/${repo}/check-runs/${job.id}/annotations`,
    )
    const refused = notes.find(notStartedBy)
    if (refused) {
      notStarted ??= refused.message.split('\n')[0]
      continue
    }
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
  return { failures, ...(notStarted && !failures.length ? { notStarted } : {}) }
}

/**
 * The verdict of completed run `run` with its `jobs`, for the gate and the `ci` tool alike: `no-run` when GitHub did not
 * start its jobs (`notStarted`, its reason), else its conclusion, with its failing tests (`failuresOf`) and seconds.
 */
export async function runVerdict(cwd: string, repo: string, run: Run, jobs: Job[]) {
  const passed = run.conclusion === 'success'
  const { failures, notStarted } = passed
    ? { failures: [], notStarted: undefined }
    : await failuresOf(cwd, repo, jobs)
  const conclusion: CiResult['conclusion'] = notStarted
    ? 'no-run'
    : passed
      ? 'success'
      : run.conclusion === 'cancelled'
        ? 'cancelled'
        : 'failure'
  return { conclusion, seconds: timesOf(jobs)?.seconds, failures, notStarted }
}
