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
export const HEAVY_CORES = 1
/**
 * How long a job the command text does not know is measured before it counts as light, one job at a time. vitest and
 * Stryker start their workers within seconds, so 20 s shows them (the incident's `slice.sh` used several cores within
 * its first poll); it is also the most a light job started beside another waits per job ahead of it.
 */
export const PROBATION_MS = 20_000
/** Below this many cores for `LIGHT_FOR_MS`, a job that counted as heavy lets the slot go: a dev server that compiled. */
export const LIGHT_CORES = 0.5
/** Long enough that a test run between two files never drops out; the incident's jobs never paused that long. */
export const LIGHT_FOR_MS = 60_000
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
  /** The load is at or above `limit` times the cores, or the pressure at or above `PRESSURE_PCT`. */
  | { kind: 'wait'; load: number; cores: number; pressure: number; limit: number }
  /** It was, for `waited` ms with nothing of the queue running: it starts anyway. */
  | { kind: 'forced'; load: number; cores: number; pressure: number; waited: number }

/**
 * The gate for a job at the head of the line. `outsideSince`: since when it has waited for CPU while the queue ran
 * nothing, so the load is not the queue's own; undefined while a job of the queue runs, which never forces a start.
 */
export function cpuGate(
  { load, cores, pressure }: MachineLoad,
  limit: number | undefined,
  outsideSince: number | undefined,
  now: number,
): CpuGate {
  if (limit === undefined || (load < limit * cores && pressure < PRESSURE_PCT))
    return { kind: 'go' }
  const waited = outsideSince === undefined ? 0 : now - outsideSince
  return waited >= PRESSURE_WAIT_MS
    ? { kind: 'forced', load, cores, pressure, waited }
    : { kind: 'wait', load, cores, pressure, limit }
}

const round = (value: number) => Math.round(value * 10) / 10
/** "load 27.6 on 6 cores, CPU pressure 36 %; starts below load 6 and 20 %". */
export const describeLoad = ({
  load,
  cores,
  pressure,
  limit,
}: Extract<CpuGate, { kind: 'wait' | 'forced' }> & { limit?: number }) =>
  `load ${round(load)} on ${cores} cores, CPU pressure ${Math.round(pressure)} %${limit === undefined ? '' : `; starts below load ${round(limit * cores)} and ${PRESSURE_PCT} %`}`

/** The CPU time a job used so far, in ms, at `at`. */
export type CpuSample = { at: number; cpuMs: number }
/**
 * What a running job's measured CPU says about it. `measuring`: on probation since `started`; `climbing` and `cooling`
 * are on their way to `heavy` and `light` since `since`. Each carries the last sample, which the next is compared with.
 */
export type Observation =
  | { kind: 'measuring'; started: number; last: CpuSample }
  | { kind: 'light'; last: CpuSample }
  | { kind: 'climbing'; since: number; last: CpuSample }
  | { kind: 'heavy'; last: CpuSample }
  | { kind: 'cooling'; since: number; last: CpuSample }

/** A job that just started, on probation: its group is new, so it has used no CPU yet. */
export const measuring = (at: number): Observation => ({
  kind: 'measuring',
  started: at,
  last: { at, cpuMs: 0 },
})

/**
 * The observation after `sample`: the only writer of `Observation`. A job on probation is decided by its average since it
 * started, as soon as it is certain; after that a job turns heavy above `HEAVY_CORES` for `heavyAfter` ms and light
 * again below `LIGHT_CORES` for `LIGHT_FOR_MS`. CPU time that left the group (a member reaped outside it) counts as none.
 */
export function observe(
  observation: Observation,
  sample: CpuSample,
  heavyAfter = PROBATION_MS,
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
      return sample.at - since >= heavyAfter
        ? { kind: 'heavy', last: sample }
        : { kind: 'climbing', since, last: sample }
    }
    case 'heavy':
    case 'cooling': {
      if (cores >= LIGHT_CORES) return { kind: 'heavy', last: sample }
      const since = observation.kind === 'cooling' ? observation.since : last.at
      return sample.at - since >= LIGHT_FOR_MS
        ? { kind: 'light', last: sample }
        : { kind: 'cooling', since, last: sample }
    }
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
