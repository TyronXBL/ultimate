/**
 * This machine's CPU admission, beside the RAM floor (`lib/memory.ts`): `cpu.maxLoadPerCore` in `~/.ultimate/settings.json`
 * turns it on. Then a job starts only while the one-minute load stays below that many times the core count and CPU
 * pressure below `PRESSURE_PCT`, and a job
 * whose command names nothing known to be heavy is measured instead of guessed: the heavy-work queue (`lib/slot.ts`)
 * holds it on probation for its first seconds, and from then on it counts by the CPU its session (`stats`) uses.
 *
 * Origin: #227574. On 2026-11-11 a wrapper script (`slice.sh` → vitest), `pnpm mutate:changed` (Stryker) twice and two
 * Playwright audits run from plain bash all counted as light by their command text and ran beside the queue's own
 * heavy job: load 27.6–36 on 6 cores, swap full. Each threshold below names the evidence it comes from; tune from there.
 */
import { readdir, readFile } from 'node:fs/promises'
import { availableParallelism, loadavg } from 'node:os'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from './settings.ts'

/**
 * Above this many cores on average a job counts as heavy. In the incident every job that overloaded the machine used
 * well above one core (vitest with 8 workers, Stryker with 2, each Chromium audit), and the light ones beside them
 * (postgres, `next start`, a seed) idled under it.
 */
const HEAVY_CORES = 1
/**
 * How long a job the command text does not know is measured, holding a place in the heavy-work queue, before it counts
 * as light and gives the place back. vitest and Stryker start their workers within seconds, so 20 s shows them (the
 * incident's `slice.sh` used several cores within its first poll); a job using a whole probation's CPU sooner counts
 * as heavy at once.
 */
export const PROBATION_MS = 20_000
/**
 * Below this many cores for `LIGHT_FOR_MS`, a heavy job gives its place back: a dev server that compiled, or a run that
 * hangs. Measured on this machine (#227574): a lander integration e2e run idles at 0.25 cores over its quietest 60 s
 * (half its 60 s windows are below 0.5), `pnpm check` at 0.87; the knowledgebase test run that hung held its place for
 * an hour at next to nothing. So well below the quietest real run, and for minutes, not seconds.
 */
const LIGHT_CORES = 0.1
/** Five times the longest quiet stretch measured in a real run; a job busy again after it takes a free place or ends. */
export const LIGHT_FOR_MS = 5 * 60_000
/**
 * A plain bash command above `HEAVY_CORES` for this long is heavy work beside the tool call (the incident's two
 * `C-flow.mjs` audits, one sent to the background with `&`). Longer than probation: a build step or an `rg` over a
 * large tree may use several cores for a few seconds, and stopping a short command would cost more than it saves.
 */
export const BASH_WINDOW_MS = 30_000
/** How often a running bash command's CPU is measured. */
export const BASH_SAMPLE_MS = 5000
/**
 * How long a job at the head of the line waits for load it did not cause before it starts anyway (under pressure): load
 * from work the queue does not run (another user, a process started with `setsid`) must not stop the machine from ever
 * running anything. Long enough for the queue's own load to fade: the one-minute average falls from the incident's
 * peak of 36 to below 6 in 60 s × ln 6 ≈ 2 min after its work ends.
 */
export const PRESSURE_WAIT_MS = 5 * 60_000

/**
 * At or above this share of the last 10 s in which some task waited for a CPU (`/proc/pressure/cpu`, `some avg10`), a
 * job waits too. The one-minute load lags a minute behind a job that just started, which in the replay of the incident
 * let `pnpm mutate:changed` start 74 s after `slice.sh` filled the machine; pressure does not. Measured on this 6-core
 * machine (#227574): 6 % at load 3.4, then 25 % within 6 s and 40 % within 20 s of one job filling every core; 36–79 %
 * during the incident.
 */
export const PRESSURE_PCT = 20

/**
 * `cpu.maxLoadPerCore` from this machine's settings, undefined while off (the default): a job starts only while the
 * one-minute load is below this times the core count. 1 means no task waits for a CPU at admission.
 */
export async function cpuLimit(userHome: string) {
  const settings = await readSettings(userSettingsPath(userHome)).catch(
    // Unreadable settings: the setup status reports them; nothing is gated meanwhile.
    (): JsonObject => ({}),
  )
  const cpu = settings.cpu
  const limit =
    cpu && typeof cpu === 'object' && !Array.isArray(cpu) ? cpu.maxLoadPerCore : undefined
  return typeof limit === 'number' && limit > 0 ? limit : undefined
}

/**
 * The one-minute load average, the cores it is shared by and CPU pressure (`some avg10`, a percentage; 0 where the
 * kernel does not report it).
 */
export type MachineLoad = { load: number; cores: number; pressure: number }
export const machineLoad = async (): Promise<MachineLoad> => ({
  load: loadavg()[0],
  cores: availableParallelism(),
  pressure: Number(
    /^some avg10=([\d.]+)/.exec(
      await readFile('/proc/pressure/cpu', 'utf8').catch(
        // No pressure stall information (not Linux, or a kernel without it): the load alone decides.
        () => '',
      ),
    )?.[1] ?? 0,
  ),
})

/** Whether a job may start now, by load. */
export type CpuGate =
  | { kind: 'go' }
  /**
   * The load or the pressure is at or above what `below` allows (`pressure` unset: not counted); `settling` while a
   * running queue job started too recently for the load to show it.
   */
  | {
      kind: 'wait'
      load: number
      cores: number
      pressure: number
      below: { load: number; pressure: number | undefined }
      settling: boolean
    }
  /** It was, for `waited` ms with nothing of the queue running: it starts anyway. */
  | { kind: 'forced'; load: number; cores: number; pressure: number; waited: number }

/**
 * How long a job runs before the one-minute load shows it: the average's own time constant. Until then a job that
 * starts beside it cannot tell how much it uses.
 */
export const LOAD_SHOWS_MS = 60_000

/** What the queue runs when a job at the head of the line has a free place. */
export type GateContext = {
  /** Queue jobs that hold a place now (running or on probation), fewer than the machine's limit. */
  running: number
  /** Every one of them started at least `LOAD_SHOWS_MS` ago. */
  settled: boolean
  /** Since when it has waited for CPU while the queue ran nothing; unset while a queue job runs. */
  outsideSince?: number
}

/**
 * The gate for a job at the head of the line, with `limit` the load per core (`cpu.maxLoadPerCore`):
 * - nothing of the queue runs: load below `limit` × cores and pressure below `PRESSURE_PCT`; load the queue does not
 *   cause delays it at most `PRESSURE_WAIT_MS`;
 * - queue jobs run and a place is free (`heavyWork.maxJobs` above one, a second job beside one): load below twice
 *   that, once the running jobs show in the load. One job already fills the machine's pressure (40 % with every core
 *   busy), so only the load can say there is room for another; the user allows two at once, and one 8-worker test run
 *   alone reaches load 14.6 on 6 cores, where a second must wait.
 */
export function cpuGate(
  { load, cores, pressure }: MachineLoad,
  limit: number | undefined,
  now: number,
  context: GateContext,
): CpuGate {
  if (limit === undefined) return { kind: 'go' }
  const beside = context.running > 0
  const below = beside
    ? { load: 2 * limit * cores, pressure: undefined }
    : { load: limit * cores, pressure: PRESSURE_PCT }
  const settling = beside && !context.settled
  if (!settling && load < below.load && (below.pressure === undefined || pressure < below.pressure))
    return { kind: 'go' }
  const waited = context.outsideSince === undefined ? 0 : now - context.outsideSince
  return waited >= PRESSURE_WAIT_MS
    ? { kind: 'forced', load, cores, pressure, waited }
    : { kind: 'wait', load, cores, pressure, below, settling }
}

const round = (value: number) => Math.round(value * 10) / 10
/**
 * "load 27.6 on 6 cores, CPU pressure 36 %", and for a wait what it waits for: "; starts below load 6 and 20 %" or
 * "; starts below load 12 once the running jobs show in the load".
 */
export const describeLoad = (gate: Extract<CpuGate, { kind: 'wait' | 'forced' }>) =>
  `load ${round(gate.load)} on ${gate.cores} cores, CPU pressure ${Math.round(gate.pressure)} %${
    gate.kind === 'wait'
      ? `; starts below load ${round(gate.below.load)}${gate.below.pressure === undefined ? '' : ` and ${gate.below.pressure} %`}${gate.settling ? ` once the running jobs show in the load (${LOAD_SHOWS_MS / 1000} s after each started)` : ''}`
      : ''
  }`

/** The CPU time a job used so far, in ms, at `at`. */
export type CpuSample = { at: number; cpuMs: number }
/**
 * What a running job's measured CPU says about it. `measuring`: on probation since `started`; `climbing` and `cooling`
 * are on their way to `heavy` and `released` since `since`. `released`: it was heavy and gave its place back;
 * `reclaiming`: heavy without a place, which its owner takes if one is free and otherwise ends it (it must never run beside
 * a full queue). Each carries the last sample, which the next is compared with.
 */
export type Observation =
  | { kind: 'measuring'; started: number; last: CpuSample }
  | { kind: 'light'; last: CpuSample }
  | { kind: 'climbing'; since: number; last: CpuSample }
  | { kind: 'heavy'; last: CpuSample }
  | { kind: 'cooling'; since: number; last: CpuSample }
  | { kind: 'released'; last: CpuSample }
  | { kind: 'reclaiming'; last: CpuSample }

/** A job that just started, on probation: its group is new, so it has used no CPU yet. */
export const measuring = (at: number): Observation => ({
  kind: 'measuring',
  started: at,
  last: { at, cpuMs: 0 },
})
/**
 * A job its command shows heavy, just started: it holds its place from the start, and gives it back like any heavy job
 * once it idles (one that hangs: a test run waiting on nothing held the queue for 50 min on 2026-11-11, #227574).
 */
export const heavyNow = (at: number): Observation => ({ kind: 'heavy', last: { at, cpuMs: 0 } })

/**
 * The observation after `sample`: the only writer of `Observation`. A job on probation is decided by its average since it
 * started, as soon as it is certain; after that a light job turns heavy above `HEAVY_CORES` for `heavyAfter` ms, and a
 * heavy one is released below `LIGHT_CORES` for `LIGHT_FOR_MS`. A released job busy again (above `HEAVY_CORES` between
 * two samples) reclaims a place: it is heavy with `place` (its owner got one for it), else reclaiming. CPU
 * time that left the session (a member reaped outside it) counts as none.
 */
export function observe(
  observation: Observation,
  sample: CpuSample,
  heavyAfter = PROBATION_MS,
  place = false,
): Observation {
  const last = observation.last
  const cores = Math.max(0, sample.cpuMs - last.cpuMs) / Math.max(1, sample.at - last.at)
  switch (observation.kind) {
    case 'measuring': {
      const elapsed = sample.at - observation.started
      // Time used never shrinks: past a whole probation's worth, its average at the end is above the line already.
      if (sample.cpuMs > HEAVY_CORES * PROBATION_MS) return { kind: 'heavy', last: sample }
      if (elapsed < PROBATION_MS) return { ...observation, last: sample }
      return sample.cpuMs / elapsed > HEAVY_CORES
        ? { kind: 'heavy', last: sample }
        : { kind: 'light', last: sample }
    }
    case 'light':
    case 'climbing': {
      if (cores <= HEAVY_CORES) return { kind: 'light', last: sample }
      const since = observation.kind === 'climbing' ? observation.since : last.at
      if (sample.at - since < heavyAfter) return { kind: 'climbing', since, last: sample }
      // Heavy without a place it may not run on: it reclaims one like a released job (review of #227574: a wrapper
      // idle through its probation would otherwise run its tests beside a full queue).
      return place ? { kind: 'heavy', last: sample } : { kind: 'reclaiming', last: sample }
    }
    case 'heavy':
    case 'cooling': {
      if (cores >= LIGHT_CORES) return { kind: 'heavy', last: sample }
      const since = observation.kind === 'cooling' ? observation.since : last.at
      return sample.at - since >= LIGHT_FOR_MS
        ? { kind: 'released', last: sample }
        : { kind: 'cooling', since, last: sample }
    }
    case 'released':
      if (cores <= HEAVY_CORES) return { kind: 'released', last: sample }
      return place ? { kind: 'heavy', last: sample } : { kind: 'reclaiming', last: sample }
    case 'reclaiming':
      // Its owner ends it unless it gets a place: only a place moves it on.
      return place ? { kind: 'heavy', last: sample } : { kind: 'reclaiming', last: sample }
    default:
      return observation satisfies never
  }
}
/** Whether a job observed so counts as heavy, holding the heavy-work slot. */
export const holdsSlot = (observation: Observation) =>
  observation.kind === 'heavy' || observation.kind === 'cooling'

/** Linux's clock tick, `getconf CLK_TCK`: 100 on every architecture Node runs on there. */
const TICK_MS = 10
type Stat = { pid: number; sid: number; ticks: number }
/**
 * Every process's session and CPU time (its own and its reaped children's, in ticks); empty where there is no /proc.
 * By session, not process group: `timeout`, which agents wrap long commands in, moves its command into a group of its
 * own (#227574: `timeout 900 node .data/audit/C-flow.mjs dark &`), while only `setsid` leaves the session that a
 * background command's leader and a bash call's shell each start (both are spawned detached, so with `setsid`).
 */
async function stats() {
  const names = await readdir('/proc').catch(
    // No /proc: not Linux, so nothing is measured.
    () => [],
  )
  const read = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map((name) =>
        readFile(`/proc/${name}/stat`, 'utf8').then(
          (stat): Stat => {
            // After the name, which may hold spaces: state, ppid, pgrp, session, …, utime (14), stime, cutime, cstime (17).
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
            return {
              pid: Number(name),
              sid: Number(fields[3]),
              ticks: fields.slice(11, 15).reduce((sum, field) => sum + Number(field), 0),
            }
          },
          // The process ended between the listing and the read.
          () => undefined,
        ),
      ),
  )
  return read.filter((stat) => stat !== undefined)
}

/** The CPU time session `sid` used so far, in ms; undefined once nothing of it is left. */
export async function sessionCpuMs(sid: number) {
  const members = (await stats()).filter((stat) => stat.sid === sid)
  return members.length ? members.reduce((sum, stat) => sum + stat.ticks, 0) * TICK_MS : undefined
}

/** The processes of session `sid` now. */
export async function sessionMembers(sid: number) {
  return (await stats()).filter((stat) => stat.sid === sid).map((stat) => stat.pid)
}

/** Send `signal` to every process of session `sid`, which the caller has verified is its own; one that ended is skipped. */
export async function signalSession(sid: number, signal: NodeJS.Signals) {
  for (const pid of await sessionMembers(sid)) send(pid, signal)
}

/** `signal` to `pid`; one that ended meanwhile is skipped. */
function send(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch (error) {
    // It ended between the listing and the signal.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** The session whose leader's environment holds `marker` (`NAME=value`), as a bash call marks its shell. */
export async function sessionMarked(marker: string) {
  for (const stat of await stats()) {
    if (stat.pid !== stat.sid) continue
    const environ = await readFile(`/proc/${stat.pid}/environ`, 'utf8').catch(
      // Another user's process, or one that ended: not ours.
      () => '',
    )
    if (environ.split('\0').includes(marker)) return stat.pid
  }
  return undefined
}
