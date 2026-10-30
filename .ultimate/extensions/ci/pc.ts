/**
 * A PC on the tailnet as the first test runner, before GitHub Actions (`.ultimate/ci-runner/README.md`). The git remote
 * `pc` names it as `<ssh host>:ci.git`; a machine without that remote never tries one. A run pushes the commit into the
 * PC's bare `ci.git`, then `ssh <host> run <sha> <suite>…` runs the suites there through the key's forced command
 * (`.ultimate/ci-runner/ultimate-ci`) and streams their output back.
 */
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify, stripVTControlCharacters } from 'node:util'
import { git } from './github.ts'
import type { Failure, JobResult } from './refs.ts'

/** The suites the runner accepts, in the order they run. */
export type Suite = 'check' | 'test' | 'test:e2e'

/**
 * `passed` and `failed` are the suites' verdict; `unavailable` (unreachable, busy, the install failed, refused) means
 * the PC gave none and the caller goes on to GitHub.
 */
export type PcRun = {
  outcome: 'passed' | 'failed' | 'unavailable'
  host: string
  seconds: number
  jobs: JobResult[]
  failures: Failure[]
  reason?: string
}

/** The runner's exit codes (`ultimate-ci`): 0 every suite passed, 1 one failed; anything else is no verdict. */
const PASSED = 0
const FAILED = 1
/** How long pushing the commit to the PC may take: a stalled push hands over to GitHub. */
const PUSH_MS = 3 * 60_000

/** The ssh host of the `pc` remote in `cwd`, or undefined on a machine without one. */
export async function pcHost(cwd: string) {
  const url = await git(cwd, ['remote', 'get-url', 'pc']).catch(
    // No `pc` remote: this machine has no PC runner, which is the common case.
    () => '',
  )
  return /^([\w.-]+):ci\.git$/.exec(url)?.[1]
}

/**
 * Run `suites` for `sha` on the PC at `host`, each output line to `line` as it comes. Never throws: a PC that cannot
 * run it resolves `unavailable` with the reason. `signal` (the caller's deadline) stops waiting: it kills the push or
 * the local ssh. The run on the PC ends when its output pipe breaks or its own time limits stop it.
 */
export async function runOnPc(
  cwd: string,
  host: string,
  sha: string,
  suites: Suite[],
  line: (text: string) => void,
  signal: AbortSignal,
): Promise<PcRun> {
  const started = Date.now()
  const result = (outcome: PcRun['outcome'], rest: Partial<PcRun> = {}): PcRun => ({
    outcome,
    host,
    seconds: Math.round((Date.now() - started) / 1000),
    jobs: [],
    failures: [],
    ...rest,
  })
  try {
    await promisify(execFile)('git', ['push', '-q', 'pc', `${sha}:refs/heads/run/${sha}`], {
      cwd,
      timeout: PUSH_MS,
      killSignal: 'SIGKILL',
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } catch (error) {
    const { stderr, killed } = error as { stderr?: string; killed?: boolean }
    // ssh's own line says why (`connect to host … timed out`); git's advice after it does not.
    const why = signal.aborted
      ? `stopped: ${String(signal.reason)}`
      : killed
        ? `it ran past ${PUSH_MS / 1000} s`
        : (stderr?.trim() || (error as Error).message).split('\n')[0]
    return result('unavailable', { reason: `pushing to ${host} failed: ${why}` })
  }
  const jobs: JobResult[] = []
  const failures: Failure[] = []
  let failed: Failure | undefined
  /** The last line of output, and the last one a suite wrote (not the runner). */
  let last = ''
  let said = ''
  const read = (text: string) => {
    line(text)
    const plain = stripVTControlCharacters(text).trim()
    if (plain) last = plain
    if (plain && !plain.startsWith('ultimate-ci: ')) said = plain
    // The runner names each suite's end: `ultimate-ci: test passed in 92 s`.
    const end = /^ultimate-ci: (\S+) (passed|failed) in (\d+) s$/.exec(plain)
    if (end)
      jobs.push({
        name: end[1],
        conclusion: end[2] === 'passed' ? 'success' : 'failure',
        seconds: Number(end[3]),
      })
    // Vitest names a failed test on a `FAIL <file> > <test>` line; the first line after it is the error.
    // A failed file reads `FAIL <file> [ <file> ]`.
    const title = /^FAIL\s+(.+)$/.exec(plain)?.[1].replace(/\s+\[[^\]]*\]$/, '')
    if (title && /^[\w./@-]+\.[cm]?[jt]sx?( > |$)/.test(title)) {
      failed = failures.some((item) => item.title === title) ? undefined : { title, message: '' }
      if (failed) failures.push(failed)
    } else if (failed && plain) {
      failed.message = plain
      failed = undefined
    }
  }
  /** ssh's exit code, else why it has none: killed by a signal, or never started. */
  const { code, ended } = await new Promise<{ code: number | null; ended: string }>((done) => {
    const child = spawn('ssh', [host, 'run', sha, ...suites], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      signal,
    })
    createInterface({ input: child.stdout }).on('line', read)
    createInterface({ input: child.stderr }).on('line', read)
    child.on('error', (error) => done({ code: null, ended: `ssh failed: ${error.message}` }))
    child.on('close', (exit, killed) =>
      done({ code: exit, ended: exit === null ? `ssh killed by ${killed}` : `exit ${exit}` }),
    )
  })
  if (code === PASSED) return result('passed', { jobs })
  if (code === FAILED) {
    // A suite that failed without naming a test (a type error in `check`) is named by its job.
    if (!failures.length)
      failures.push({
        title: `${jobs.find((job) => job.conclusion === 'failure')?.name ?? suites.join(' ')} (pc)`,
        message: said,
      })
    return result('failed', { jobs, failures })
  }
  return result('unavailable', {
    jobs,
    reason: signal.aborted
      ? `stopped: ${String(signal.reason)}`
      : `${host} gave no verdict (${ended}): ${last}`,
  })
}
