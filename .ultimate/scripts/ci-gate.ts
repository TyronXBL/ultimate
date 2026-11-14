// The lander's only check (#273712): it decides what still has to run of `pnpm check`, `pnpm audit --audit-level high`,
// `pnpm test` and `pnpm test:e2e`, the four CI's workflow runs, and its last line names what was covered and where.
// - A recent GitHub pass of exactly the checked-out commit stands in for all four (#205147, `gatePlan` and `reusable`
//   in github.ts); its origin goes on a `lander-reused:` line, which the landing card shows.
// - A GitHub run of it under way covers all four too: the gate waits for it and runs nothing here.
// - Otherwise it runs the audit here first, then with a `pc` remote asks that PC for check, test and test:e2e
//   (`.ultimate/extensions/ci/pc.ts`), whose verdict is final. Without a PC, or when it gives no verdict (unreachable,
//   busy), it runs `pnpm check` here, then pushes the commit to `<remote>:ci/<sha>`, waits for its GitHub Actions run and
//   exits with its result.
// - When GitHub gives no verdict (unreachable, or Actions refused to start the jobs for billing) it runs here whichever
//   of the audit and check has not run yet, then the suites, and says so.
// `pnpm check` and the suites run here as jobs of the machine's heavy-work queue (`lib/slot.ts`) once their turn comes
// and the RAM floor admits them; the light audit runs at once. The API calls carry the remote's stored Git credential
// when there is one (`.ultimate/extensions/ci/github.ts`).
//
// Usage, in the checkout to test: node .ultimate/scripts/ci-gate.ts [remote]   (default remote: fork)
// CI_GATE_API overrides the API base URL (default https://api.github.com).
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { commandNeedMiB } from '../../lib/memory.ts'
import {
  describeWait,
  enterSlot,
  keepHeld,
  releaseSlot,
  SLOT_POLL_MS,
  slotLimits,
  slotWait,
  thisProcess,
} from '../../lib/slot.ts'
import type { SlotClaim } from '../../lib/slot.ts'
import {
  gatePlan,
  git,
  jobResult,
  pollMs,
  repository,
  reusable,
  runsOf,
  runState,
  runVerdict,
  secretsIn,
  Unreachable,
} from '../extensions/ci/github.ts'
import type { Run } from '../extensions/ci/github.ts'
import { pcHost, runOnPc } from '../extensions/ci/pc.ts'
import type { Suite } from '../extensions/ci/pc.ts'

const remote = process.argv[2] ?? 'fork'
const cwd = process.cwd()
/** How long a pushed commit may wait for its run to appear. */
const APPEAR_MS = 5 * 60_000
/** What runs here before a runner when nothing covers it, with the time limits it had as lander checks of its own. */
const HERE = {
  audit: { command: ['pnpm', 'audit', '--audit-level', 'high'], limitMs: 120_000 },
  check: { command: ['pnpm', 'check'], limitMs: 300_000 },
}
type Here = keyof typeof HERE
const LOCAL = [
  ['pnpm', 'test'],
  ['pnpm', 'test:e2e'],
]
const LOCAL_TIMEOUT_MS = 600_000
/** What the PC runs: all but the audit, which ran here before it. */
const PC_SUITES: Suite[] = ['check', 'test', 'test:e2e']
/** Everything a pass covers: a GitHub run's first shard runs check and audit beside its tests (`.github/workflows/ci.yml`). */
const ALL = ['check', 'audit', 'test', 'test:e2e']
/** How long the PC may take before GitHub runs it instead, within the lander's 37 min for this check. */
const PC_TIMEOUT_MS = 15 * 60_000
/** How long a local suite at the head of the heavy-work queue waits for the RAM floor to admit it before the gate fails. */
const RAM_WAIT_MS = 10 * 60_000

const log = (line: string) => console.log(`ci-gate: ${line}`)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
/** `a, b and c`. */
const listed = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** The line the lander reads a reused pass from (extensions/workspaces/README.md). */
const REUSED = 'lander-reused: '

/**
 * What earlier runs of `sha` decide: `reused` when a recent pass stands in (its origin printed); else why the suites
 * run, with the run to `wait` for when one of it is under way. One try each: GitHub failing here only means nothing is
 * reused, and must not stall the gate past the lander's two minutes without output.
 */
async function earlier(
  sha: string,
): Promise<{ reused: true } | { reused: false; why: string; wait?: Run }> {
  try {
    const repo = await repository(cwd, remote)
    const plan = gatePlan(await runsOf(cwd, repo, sha, undefined, 1), sha)
    if (plan.kind === 'wait')
      return {
        reused: false,
        wait: plan.run,
        why: `waited for the run under way, ${plan.run.html_url}`,
      }
    if (plan.kind === 'fresh') return { reused: false, why: plan.why }
    const { jobs } = await runState(cwd, repo, plan.run.id, 1)
    const verdict = reusable(plan.run, jobs, sha, Date.now())
    if (!verdict.origin) return { reused: false, why: verdict.why }
    const age = Math.round((Date.now() - verdict.origin.completedAt) / 60_000)
    console.log(`${REUSED}${JSON.stringify(verdict.origin)}`)
    log(
      `reused: ${verdict.origin.runner} passed ${listed(ALL)} for ${sha.slice(0, 7)} ${age} min ago, ${plan.run.html_url}`,
    )
    return { reused: true }
  } catch (error) {
    return { reused: false, why: `earlier CI runs unreadable: ${(error as Error).message}` }
  }
}

/**
 * Run the suites of `sha` on GitHub Actions or wait for `waiting`, its run under way; `why` they run and what passed
 * `here` before, for the last line.
 */
async function gate(repo: string, sha: string, why: string, here: Here[], waiting?: Run) {
  const poll = await pollMs(cwd, repo)
  const before = waiting ? [] : await runsOf(cwd, repo, sha)
  // A run still going (the branch's own, a resumed lander) is waited for; else a push of a new ref starts one.
  let run = waiting ?? before.find((candidate) => candidate.status !== 'completed')
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
        const { conclusion, failures, notStarted } = await runVerdict(cwd, repo, run, state.jobs)
        if (conclusion === 'success') {
          log(
            `ran fresh (${why}): GitHub Actions passed ${listed(ALL)} for ${sha.slice(0, 7)}, ${run.html_url}${here.length ? `; ${listed(here)} passed here first` : ''}`,
          )
          return 0
        }
        if (notStarted)
          throw new Unreachable(`GitHub Actions did not start the jobs: ${notStarted}`)
        // Vitest titles a failure with its test, `file > name`; the message's first line is the error.
        for (const failure of failures) console.log(`FAIL ${failure.title}\n  ${failure.message}`)
        const failedJobs = state.jobs.filter((job) => job.conclusion === 'failure')
        log(
          `GitHub Actions ${run.conclusion}${failedJobs.length ? ` in ${listed(failedJobs.map((job) => job.name))}` : ''} for ${sha.slice(0, 7)}: ${run.html_url}`,
        )
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
  log(`running ${listed(PC_SUITES)} on ${host}`)
  const run = await runOnPc(
    cwd,
    host,
    sha,
    PC_SUITES,
    (line) => console.log(line),
    AbortSignal.timeout(PC_TIMEOUT_MS),
  )
  if (run.outcome === 'unavailable') {
    log(`${run.reason}; GitHub Actions runs it instead`)
    return undefined
  }
  for (const job of run.jobs) log(`  ${job.name}: ${job.conclusion} in ${job.seconds} s on ${host}`)
  if (run.outcome === 'passed') {
    log(
      `ran fresh (${why}): ${host} passed ${listed(PC_SUITES)} for ${sha.slice(0, 7)} in ${run.seconds} s; audit passed here`,
    )
    return 0
  }
  for (const failure of run.failures) console.log(`FAIL ${failure.title}\n  ${failure.message}`)
  const failed = run.jobs.filter((job) => job.conclusion === 'failure').map((job) => job.name)
  log(
    `${host} failed ${failed.length ? listed(failed) : listed(PC_SUITES)} for ${sha.slice(0, 7)} in ${run.seconds} s`,
  )
  return 1
}

/**
 * Wait in the heavy-work queue until `command`'s turn comes and the RAM floor admits it; then this process holds the
 * slot, and the returned function lets it go. Undefined when RAM stayed short at the head of the line for `RAM_WAIT_MS`.
 */
async function admitted(command: string[]) {
  const limits = await slotLimits(homedir())
  const need = commandNeedMiB(command.join(' '))
  const claim: SlotClaim = {
    id: `ci-gate:${process.pid}:${command.join(' ')}`,
    kind: 'heavy',
    at: Date.now(),
    label: command.join(' '),
    from: `the lander's CI gate in ${basename(cwd)}`,
  }
  let waited: { ramSince?: number; pressureSince?: number } = {}
  for (let polls = 0; ; polls++) {
    const { pressureSince } = waited
    const entered = await enterSlot(claim, { limits, need, pressureSince, start: thisProcess })
    if (entered.kind === 'started') return keepHeld(claim)
    const wait = slotWait(entered, waited, Date.now(), RAM_WAIT_MS)
    if (wait.kind === 'gave-up') {
      await releaseSlot(claim.id)
      log(
        `not enough RAM for ${command.join(' ')} after ${RAM_WAIT_MS / 60_000} min: ${describeWait(entered)}`,
      )
      return undefined
    }
    waited = wait.waited
    // A line a minute: the lander stops a check after 2 min without output.
    if (polls % (60_000 / SLOT_POLL_MS) === 0) log(`${command.join(' ')}: ${describeWait(entered)}`)
    await sleep(SLOT_POLL_MS)
  }
}

/** Run `command` once the heavy-work queue admits it, as `spawnLocal` does; 1 when RAM never admitted it. */
async function local(command: string[], limitMs = LOCAL_TIMEOUT_MS) {
  const release = await admitted(command)
  if (!release) return 1
  try {
    return await spawnLocal(command, limitMs)
  } finally {
    await release()
  }
}
/**
 * Run `command` in its own process group, stopped with it after `limitMs`; resolves its exit code, after a line naming
 * the failure when it failed.
 */
function spawnLocal(command: string[], limitMs: number) {
  return new Promise<number>((done) => {
    log(`running ${command.join(' ')} locally (limit ${limitMs / 1000} s)`)
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true })
    const timer = setTimeout(() => {
      log(`${command.join(' ')} ran past ${limitMs / 1000} s; stopping it`)
      process.kill(-child.pid!, 'SIGKILL')
    }, limitMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0)
        log(
          `${command.join(' ')} failed on this machine (${code === null ? signal : `exit ${code}`})`,
        )
      done(code ?? 1)
    })
  })
}

/** Run `name` here: the check in the heavy-work queue, the light audit at once. */
const runHere = (name: Here) =>
  name === 'check'
    ? local(HERE.check.command, HERE.check.limitMs)
    : spawnLocal(HERE.audit.command, HERE.audit.limitMs)

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
  /** What passed on this machine, in the order it ran. */
  const here: Here[] = []
  // A run of this commit under way covers the audit and check too, and is not tested a second time on the PC.
  if (!found.wait) {
    const audit = await runHere('audit')
    if (audit !== 0) return audit
    here.push('audit')
    const pc = await onPc(sha, found.why)
    if (pc !== undefined) return pc
    // The check fails here in a minute rather than after a push and a GitHub run.
    const check = await runHere('check')
    if (check !== 0) return check
    here.push('check')
  }
  try {
    return await gate(await repository(cwd, remote), sha, found.why, here, found.wait)
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error
    const missing = (['audit', 'check'] as const).filter((name) => !here.includes(name))
    console.log(
      [
        '',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        `!! CI GATE FALLBACK: ${error.message}`,
        `!! GitHub gave no verdict; running ${listed([...missing, 'test', 'test:e2e'])} on this machine instead.`,
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '',
      ].join('\n'),
    )
    for (const name of missing) {
      const code = await runHere(name)
      if (code !== 0) return code
    }
    for (const command of LOCAL) {
      const code = await local(command)
      if (code !== 0) return code
    }
    log(`FALLBACK: ${listed(ALL)} passed on this machine (CI was not used; ${found.why})`)
    return 0
  }
}

process.exitCode = await main()
