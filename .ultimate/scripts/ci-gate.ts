// The lander's test gate: push the checked-out commit to `<remote>:ci/<sha>`, wait for its GitHub Actions run and exit
// with its result. When GitHub cannot be reached it runs `pnpm test` and `pnpm test:e2e` here instead, and says so.
//
// Usage, in the checkout to test: node .ultimate/scripts/ci-gate.ts [remote]   (default remote: fork)
// CI_GATE_API overrides the API base URL (default https://api.github.com).
import { execFileSync, spawn } from 'node:child_process'

const remote = process.argv[2] ?? 'fork'
const api = process.env.CI_GATE_API ?? 'https://api.github.com'
const POLL_MS = 60_000
/** Consecutive failed API calls before GitHub counts as unreachable. */
const API_TRIES = 3
/** How long a pushed commit may wait for its run to appear. */
const APPEAR_MS = 5 * 60_000
const LOCAL = [
  ['pnpm', 'test'],
  ['pnpm', 'test:e2e'],
]
const LOCAL_TIMEOUT_MS = 600_000
// The token and key shapes that must never reach the public fork (GitHub, OpenAI, Anthropic, AWS, Slack, Google, keys).
const SECRETS =
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/

type Run = { id: number; status: string; conclusion: string | null; html_url: string }
type Job = {
  id: number
  name: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
}

class Unreachable extends Error {}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const log = (line: string) => console.log(`ci-gate: ${line}`)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function repository() {
  const url = git('remote', 'get-url', remote)
  const match = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/.exec(url)
  if (!match) throw new Error(`${remote} is not a GitHub remote: ${url}`)
  return match[1]
}

/** Commits the push would publish, scanned for secret shapes; names where, never what. */
function secretsIn(sha: string) {
  const patch = git('log', '-p', '--format=commit %H%n%B', sha, '--not', `--remotes=${remote}`)
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

async function call<T>(path: string): Promise<T> {
  let failure = ''
  for (let attempt = 1; attempt <= API_TRIES; attempt++) {
    try {
      const response = await fetch(`${api}${path}`, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) return (await response.json()) as T
      failure = `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    log(`API call ${path} failed (${attempt}/${API_TRIES}): ${failure}`)
    if (attempt < API_TRIES) await sleep(Math.min(POLL_MS, 10_000))
  }
  throw new Unreachable(`the GitHub API failed ${API_TRIES} times: ${failure}`)
}

const runsOf = async (repo: string, sha: string) =>
  (await call<{ workflow_runs: Run[] }>(`/repos/${repo}/actions/runs?head_sha=${sha}&event=push`))
    .workflow_runs

const seconds = (job: Job) =>
  job.started_at && job.completed_at
    ? `${Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000)} s`
    : '-'

async function gate(repo: string, sha: string) {
  const before = await runsOf(repo, sha)
  if (before.some((run) => run.conclusion === 'success')) {
    log(
      `${sha.slice(0, 7)} already passed CI: ${before.find((run) => run.conclusion === 'success')!.html_url}`,
    )
    return 0
  }
  // A run still going (a resumed lander) is waited for; after failed runs, a rerun pushes a new ref, which starts one.
  let run = before.find((candidate) => candidate.status !== 'completed')
  const refs: string[] = []
  if (!run) {
    const failed = before.length
    const ref = `ci/${sha}${failed ? `-${failed + 1}` : ''}`
    try {
      git('push', '-q', remote, `${sha}:refs/heads/${ref}`)
    } catch (error) {
      throw new Unreachable(`pushing ${ref} to ${remote} failed: ${(error as Error).message}`)
    }
    refs.push(ref)
    log(`pushed ${ref} to ${remote}; waiting for its run`)
  }
  try {
    const since = Date.now()
    while (!run) {
      await sleep(Math.min(POLL_MS, 15_000))
      run = (await runsOf(repo, sha)).find(
        (candidate) => !before.some((old) => old.id === candidate.id),
      )
      if (!run && Date.now() - since > APPEAR_MS)
        throw new Unreachable(`no Actions run started for ${sha.slice(0, 7)} within 5 min`)
      if (!run) log('no run yet')
    }
    log(`run ${run.html_url}`)
    for (;;) {
      const { jobs } = await call<{ jobs: Job[] }>(`/repos/${repo}/actions/runs/${run.id}/jobs`)
      run = await call<Run>(`/repos/${repo}/actions/runs/${run.id}`)
      log(
        `${run.status}: ${jobs.map((job) => `${job.name} ${job.conclusion ?? 'running'}`).join(', ') || 'queued'}`,
      )
      if (run.status === 'completed') {
        for (const job of jobs) log(`  ${job.name}: ${job.conclusion} in ${seconds(job)}`)
        if (run.conclusion === 'success') return 0
        const failed = jobs.filter(
          (job) => job.conclusion !== 'success' && job.conclusion !== 'skipped',
        )
        for (const job of failed) {
          const notes = await call<
            {
              path: string
              start_line: number
              title?: string
              message: string
              annotation_level: string
            }[]
          >(`/repos/${repo}/check-runs/${job.id}/annotations`).catch(
            // The run's conclusion already decides; without annotations the job name still reports it below.
            () => [],
          )
          const failures = notes.filter(
            (note) => note.annotation_level === 'failure' && note.path !== '.github',
          )
          for (const note of failures)
            // Vitest titles a failure with its test, `file > name`; the message's first line is the error.
            console.log(
              `FAIL ${note.title || `${note.path}:${note.start_line}`}: ${note.message.split('\n')[0]}`,
            )
          if (!failures.length)
            console.log(`FAIL ${job.name} (${job.conclusion}), see ${run.html_url}`)
        }
        log(`CI ${run.conclusion} for ${sha.slice(0, 7)}: ${run.html_url}`)
        return 1
      }
      await sleep(POLL_MS)
    }
  } finally {
    for (const ref of refs) {
      try {
        git('push', '-q', remote, '--delete', ref)
      } catch (error) {
        // The run's result is what counts; a leftover ci/ branch only clutters the fork.
        log(`could not delete ${ref}: ${(error as Error).message}`)
      }
    }
  }
}

/** Run `command` in its own process group, stopped with it after the time limit; resolves its exit code. */
function local(command: string[]) {
  return new Promise<number>((done) => {
    log(`running ${command.join(' ')} locally (limit ${LOCAL_TIMEOUT_MS / 1000} s)`)
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true })
    const timer = setTimeout(() => {
      log(`${command.join(' ')} ran past ${LOCAL_TIMEOUT_MS / 1000} s; stopping it`)
      process.kill(-child.pid!, 'SIGKILL')
    }, LOCAL_TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      done(code ?? 1)
    })
  })
}

async function main() {
  const sha = git('rev-parse', 'HEAD')
  const leaks = secretsIn(sha)
  if (leaks.length) {
    log(`refusing to push ${sha.slice(0, 7)}: possible secrets in`)
    for (const leak of leaks) console.log(`FAIL secret pattern in ${leak}`)
    return 1
  }
  try {
    return await gate(repository(), sha)
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    console.log(
      [
        '',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        `!! CI GATE FALLBACK: ${error.message}`,
        '!! GitHub is unreachable; running the test suites on this machine instead.',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '',
      ].join('\n'),
    )
    for (const command of LOCAL) {
      const code = await local(command)
      if (code !== 0) return code
    }
    log('FALLBACK: local suites passed (CI was not used)')
    return 0
  }
}

process.exitCode = await main()
