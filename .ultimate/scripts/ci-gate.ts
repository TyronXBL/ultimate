// The lander's test gate. A recent GitHub pass of exactly the checked-out commit stands in for the suites (#205147,
// `gatePlan` and `reusable` in github.ts); its origin goes on a `lander-reused:` line, which the landing card shows.
// Otherwise, with a `pc` remote it first runs `pnpm test` and `pnpm test:e2e` on that PC
// (`.ultimate/extensions/ci/pc.ts`); when the PC gives no verdict (unreachable, busy), it pushes the checked-out commit
// to `<remote>:ci/<sha>`, waits for its GitHub Actions run and exits with its result. When GitHub gives no verdict
// either (unreachable, or Actions refused to start the jobs for billing) it runs the suites here instead, each as a job
// of the machine's heavy-work queue (`lib/slot.ts`) once its turn comes and the RAM floor admits it, and says so.
// The API calls carry the remote's stored Git credential when there is one (`.ultimate/extensions/ci/github.ts`).
//
// Usage, in the checkout to test: node .ultimate/scripts/ci-gate.ts [remote]   (default remote: fork)
// CI_GATE_API overrides the API base URL (default https://api.github.com).
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { commandNeedMiB, memoryFloor } from '../../lib/memory.ts'
import { describeWait, enterSlot, keepHeld, SLOT_POLL_MS, thisProcess } from '../../lib/slot.ts'
import type { SlotClaim } from '../../lib/slot.ts'
import {
  failuresOf,
  gatePlan,
  git,
  jobResult,
  pollMs,
  repository,
  reusable,
  runsOf,
  runState,
  secretsIn,
  Unreachable,
} from '../extensions/ci/github.ts'
import type { Run } from '../extensions/ci/github.ts'
import { pcHost, runOnPc } from '../extensions/ci/pc.ts'

const remote = process.argv[2] ?? 'fork'
const cwd = process.cwd()
/** How long a pushed commit may wait for its run to appear. */
const APPEAR_MS = 5 * 60_000
const LOCAL = [
  ['pnpm', 'test'],
  ['pnpm', 'test:e2e'],
]
const LOCAL_TIMEOUT_MS = 600_000
/** How long the PC may take before GitHub runs it instead, within the lander's 30 min for this check. */
const PC_TIMEOUT_MS = 15 * 60_000
/** How long a local suite at the head of the heavy-work queue waits for the RAM floor to admit it before the gate fails. */
const RAM_WAIT_MS = 10 * 60_000

const log = (line: string) => console.log(`ci-gate: ${line}`)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** The line the lander reads a reused pass from (extensions/workspaces/README.md). */
const REUSED = 'lander-reused: '

/**
 * What earlier runs of `sha` decide: `reused` when a recent pass stands in (its origin printed); else why the suites
 * run, with `wait` when a run of it is under way. One try each: GitHub failing here only means nothing is reused, and
 * must not stall the gate past the lander's two minutes without output.
 */
async function earlier(
  sha: string,
): Promise<{ reused: true } | { reused: false; why: string; wait?: true }> {
  try {
    const repo = await repository(cwd, remote)
    const plan = gatePlan(await runsOf(cwd, repo, sha, undefined, 1), sha)
    if (plan.kind === 'wait')
      return {
        reused: false,
        wait: true,
        why: `waited for the run under way, ${plan.run.html_url}`,
      }
    if (plan.kind === 'fresh') return { reused: false, why: plan.why }
    const { jobs } = await runState(cwd, repo, plan.run.id, 1)
    const verdict = reusable(plan.run, jobs, sha, Date.now())
    if (!verdict.origin) return { reused: false, why: verdict.why }
    const age = Math.round((Date.now() - verdict.origin.completedAt) / 60_000)
    console.log(`${REUSED}${JSON.stringify(verdict.origin)}`)
    log(`reused: ${sha.slice(0, 7)} passed CI ${age} min ago, ${plan.run.html_url}`)
    return { reused: true }
  } catch (error) {
    return { reused: false, why: `earlier CI runs unreadable: ${(error as Error).message}` }
  }
}

/** Run the suites of `sha` on GitHub Actions, or wait for its run under way; `why` they run, for the last line. */
async function gate(repo: string, sha: string, why: string) {
  const poll = await pollMs(cwd, repo)
  const before = await runsOf(cwd, repo, sha)
  // A run still going (the branch's own, a resumed lander) is waited for; else a push of a new ref starts one.
  let run: Run | undefined = before.find((candidate) => candidate.status !== 'completed')
  const refs: string[] = []
  if (!run) {
    const runs = before.length
    const ref = `ci/${sha}${runs ? `-${runs + 1}` : ''}`
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
        if (run.conclusion === 'success') {
          log(`ran fresh (${why}): GitHub Actions passed ${sha.slice(0, 7)}, ${run.html_url}`)
          return 0
        }
        const { failures, notStarted } = await failuresOf(cwd, repo, state.jobs)
        if (notStarted)
          throw new Unreachable(`GitHub Actions did not start the jobs: ${notStarted}`)
        // Vitest titles a failure with its test, `file > name`; the message's first line is the error.
        for (const failure of failures) console.log(`FAIL ${failure.title}\n  ${failure.message}`)
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

/** The PC's exit code for `sha`, or undefined when there is no PC or it gave no verdict. */
async function onPc(sha: string, why: string) {
  const host = await pcHost(cwd)
  if (!host) return undefined
  log(`running test and test:e2e on ${host}`)
  const run = await runOnPc(
    cwd,
    host,
    sha,
    ['test', 'test:e2e'],
    (line) => console.log(line),
    AbortSignal.timeout(PC_TIMEOUT_MS),
  )
  if (run.outcome === 'unavailable') {
    log(`${run.reason}; GitHub Actions runs it instead`)
    return undefined
  }
  for (const job of run.jobs) log(`  ${job.name}: ${job.conclusion} in ${job.seconds} s on ${host}`)
  if (run.outcome === 'passed') {
    log(`ran fresh (${why}): ${host} passed ${sha.slice(0, 7)} in ${run.seconds} s`)
    return 0
  }
  for (const failure of run.failures) console.log(`FAIL ${failure.title}\n  ${failure.message}`)
  log(`${host} failed ${sha.slice(0, 7)} in ${run.seconds} s`)
  return 1
}

/**
 * Wait in the heavy-work queue until `command`'s turn comes and the RAM floor admits it; then this process holds the
 * slot, and the returned function lets it go. Undefined when RAM stayed short at the head of the line for `RAM_WAIT_MS`.
 */
async function admitted(command: string[]) {
  const floor = await memoryFloor(homedir())
  const need = commandNeedMiB(command.join(' '))
  const claim: SlotClaim = {
    id: `ci-gate:${process.pid}:${command.join(' ')}`,
    at: Date.now(),
    label: command.join(' '),
    from: `the lander's CI gate in ${basename(cwd)}`,
  }
  let ramSince: number | undefined
  for (let polls = 0; ; polls++) {
    const entered = await enterSlot(claim, { floor, need, start: thisProcess })
    if (entered.kind === 'started') return keepHeld(claim)
    ramSince = entered.kind === 'ram' ? (ramSince ?? Date.now()) : undefined
    if (ramSince !== undefined && Date.now() - ramSince > RAM_WAIT_MS) {
      log(
        `not enough RAM for ${command.join(' ')} after ${RAM_WAIT_MS / 60_000} min: ${describeWait(entered)}`,
      )
      return undefined
    }
    // A line a minute: the lander stops a check after 2 min without output.
    if (polls % (60_000 / SLOT_POLL_MS) === 0) log(`${command.join(' ')}: ${describeWait(entered)}`)
    await sleep(SLOT_POLL_MS)
  }
}

/** Run `command` in its own process group, stopped with it after the time limit; resolves its exit code. */
async function local(command: string[]) {
  const release = await admitted(command)
  if (!release) return 1
  try {
    return await spawnLocal(command)
  } finally {
    await release()
  }
}
function spawnLocal(command: string[]) {
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
  const found = await earlier(sha)
  if (found.reused) return 0
  // A run of this commit under way is waited for, not tested a second time on the PC.
  const pc = found.wait ? undefined : await onPc(sha, found.why)
  if (pc !== undefined) return pc
  try {
    return await gate(await repository(cwd, remote), sha, found.why)
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    console.log(
      [
        '',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        `!! CI GATE FALLBACK: ${error.message}`,
        '!! GitHub gave no verdict; running the test suites on this machine instead.',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '',
      ].join('\n'),
    )
    for (const command of LOCAL) {
      const code = await local(command)
      if (code !== 0) return code
    }
    log(`FALLBACK: local suites passed (CI was not used; ${found.why})`)
    return 0
  }
}

process.exitCode = await main()
