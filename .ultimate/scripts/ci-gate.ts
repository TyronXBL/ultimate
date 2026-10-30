// The lander's test gate: push the checked-out commit to `<remote>:ci/<sha>`, wait for its GitHub Actions run and exit
// with its result. When GitHub cannot be reached it runs `pnpm test` and `pnpm test:e2e` here instead, and says so.
// The API calls carry the remote's stored Git credential when there is one (`.ultimate/extensions/ci/github.ts`).
//
// Usage, in the checkout to test: node .ultimate/scripts/ci-gate.ts [remote]   (default remote: fork)
// CI_GATE_API overrides the API base URL (default https://api.github.com).
import { spawn } from 'node:child_process'
import {
  failuresOf,
  git,
  jobResult,
  pollMs,
  repository,
  runsOf,
  runState,
  secretsIn,
  Unreachable,
} from '../extensions/ci/github.ts'
import type { Run } from '../extensions/ci/github.ts'

const remote = process.argv[2] ?? 'fork'
const cwd = process.cwd()
/** How long a pushed commit may wait for its run to appear. */
const APPEAR_MS = 5 * 60_000
const LOCAL = [
  ['pnpm', 'test'],
  ['pnpm', 'test:e2e'],
]
const LOCAL_TIMEOUT_MS = 600_000

const log = (line: string) => console.log(`ci-gate: ${line}`)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function gate(repo: string, sha: string) {
  const poll = await pollMs(cwd, repo)
  const before = await runsOf(cwd, repo, sha)
  const passed = before.find((run) => run.conclusion === 'success')
  if (passed) {
    log(`${sha.slice(0, 7)} already passed CI: ${passed.html_url}`)
    return 0
  }
  // A run still going (a resumed lander) is waited for; after failed runs, a rerun pushes a new ref, which starts one.
  let run: Run | undefined = before.find((candidate) => candidate.status !== 'completed')
  const refs: string[] = []
  if (!run) {
    const failed = before.length
    const ref = `ci/${sha}${failed ? `-${failed + 1}` : ''}`
    try {
      await git(cwd, ['push', '-q', remote, `${sha}:refs/heads/${ref}`])
    } catch (error) {
      throw new Unreachable(`pushing ${ref} to ${remote} failed: ${(error as Error).message}`)
    }
    refs.push(ref)
    log(`pushed ${ref} to ${remote}; waiting for its run`)
  }
  try {
    const since = Date.now()
    while (!run) {
      await sleep(poll)
      run = (await runsOf(cwd, repo, sha)).find(
        (candidate) => !before.some((old) => old.id === candidate.id),
      )
      if (!run && Date.now() - since > APPEAR_MS)
        throw new Unreachable(`no Actions run started for ${sha.slice(0, 7)} within 5 min`)
      if (!run) log('no run yet')
    }
    log(`run ${run.html_url}`)
    for (;;) {
      const state = await runState(cwd, repo, run.id)
      run = state.run
      log(
        `${run.status}: ${state.jobs.map((job) => `${job.name} ${job.conclusion ?? 'running'}`).join(', ') || 'queued'}`,
      )
      if (run.status === 'completed') {
        for (const job of state.jobs.map(jobResult))
          log(
            `  ${job.name}: ${job.conclusion} in ${job.seconds === undefined ? '-' : `${job.seconds} s`}`,
          )
        if (run.conclusion === 'success') return 0
        // Vitest titles a failure with its test, `file > name`; the message's first line is the error.
        for (const failure of await failuresOf(cwd, repo, state.jobs))
          console.log(`FAIL ${failure.title}: ${failure.message}`)
        log(`CI ${run.conclusion} for ${sha.slice(0, 7)}: ${run.html_url}`)
        return 1
      }
      await sleep(poll)
    }
  } finally {
    for (const ref of refs) {
      try {
        await git(cwd, ['push', '-q', remote, '--delete', ref])
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
  const sha = await git(cwd, ['rev-parse', 'HEAD'])
  const leaks = await secretsIn(cwd, sha, remote)
  if (leaks.length) {
    log(`refusing to push ${sha.slice(0, 7)}: possible secrets in`)
    for (const leak of leaks) console.log(`FAIL secret pattern in ${leak}`)
    return 1
  }
  try {
    return await gate(await repository(cwd, remote), sha)
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
