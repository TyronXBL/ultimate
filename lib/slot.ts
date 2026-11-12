/**
 * The machine's heavy-work queue: up to the machine's limit of heavy jobs at once (`heavyWork.maxJobs`, default one:
 * tests, checks, installs, builds, the lander's checks), taken
 * in the order the jobs asked, by every Ultimate on the machine and its previews. Its state lives beside the RAM
 * admission's (`lib/memory.ts`), in the same folder and under the same lock, so the job at the head of the line also
 * waits for RAM above the floor, in the same step that grants it the slot.
 *
 * `SlotQueue` is a list of entries, each a union on `state`; `slotStep` is the only writer of it and `slotTurn` the
 * derivation every reader uses. The file is a cache of who waits and who runs, never the only record:
 * - a waiter keeps the time it asked (`SlotClaim.at`) in its own durable state and says so again at every look, so the
 *   line's order survives a host restart and a removed file; a waiter that stops looking drops out after a while;
 * - a running job's entry lives as long as its holder process (its pid and start time), so a job that dies frees the
 *   slot at the next look; its owner says so again at every look too;
 * - when the file disappears after this process saw it (the daily temp cleanup, or by hand), nobody gets the slot until
 *   every running job had the time to say so again (`SETTLE_MS`).
 *
 * With CPU admission on (`lib/cpu.ts`, #227574), every background job queues, not only those whose command text says
 * heavy: one it does not know takes a place on probation (`measuring`) while it is measured, keeps it like a heavy one
 * once it uses more than a core (`heavy`) and gives it back when it is light. The head of the line also waits for load.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@earendil-works/pi-durable'
import {
  cpuGate,
  cpuLimit,
  describeLoad,
  LOAD_SHOWS_MS,
  machineLoad,
  PRESSURE_WAIT_MS,
  PROBATION_MS,
} from './cpu.ts'
import type { CpuGate } from './cpu.ts'
import { readJson, writeJson } from './json-file.ts'
import { admitIn, describeShort, locked, memoryCap, memoryFloor, stateDir } from './memory.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import type { RamShort } from './memory.ts'
import { identify } from './process-group.ts'

/** A job asking for the slot. */
export type SlotClaim = {
  /** Unique on the machine and the same across restarts: `<home>:background:<task>`. */
  id: string
  /**
   * `heavy`: its command is known to be (tests, checks, builds), so it holds the slot while it runs. `unknown`: it is
   * measured, holding the slot only on probation and while it uses more than a core.
   */
  kind: 'heavy' | 'unknown'
  /** When it asked, kept by its owner across restarts: the line's order, earliest first. */
  at: number
  /** What it runs, shortened: `pnpm check`. */
  label: string
  /** Who asked: `#202077 in ultimate`. */
  from: string
}
/** The process whose life bounds a running job, with its start time (`identify`), so a reused pid never counts. */
type SlotHolder = { pid: number; identity: string }
export type SlotEntry =
  | (SlotClaim & { state: 'waiting'; seen: number })
  /** An unknown job on probation until `until`: it takes a place until it is measured light. */
  | (SlotClaim & { state: 'measuring'; since: number; until: number; holder: SlotHolder })
  | (SlotClaim & { state: 'running'; since: number; holder: SlotHolder })
type Holding = Extract<SlotEntry, { state: 'measuring' | 'running' }>
export type SlotQueue = {
  entries: SlotEntry[]
  /** Set when the file was found removed: until then nobody gets the slot. */
  settleUntil?: number
}

/** What changes the queue. */
export type SlotEvent =
  /** A job waits, or says again that it still does. */
  | { type: 'wait'; claim: SlotClaim; now: number }
  /**
   * A job got the slot, or its owner says again that it still runs: a heavy one runs, an unknown one is measured. Said
   * again, it keeps its state and when it started.
   */
  | { type: 'start'; claim: SlotClaim; holder: SlotHolder; now: number }
  /** A running job was measured above a core: it holds the slot from now on, whatever its claim. */
  | { type: 'heavy'; claim: SlotClaim; holder: SlotHolder; now: number }
  /** A job ended, gave up or was stopped. */
  | { type: 'release'; id: string }
  /** Drop waiters that stopped looking and running jobs whose holder is gone. */
  | { type: 'expire'; now: number; alive: (holder: SlotHolder) => boolean }

/** A waiter looks every 5 s; one not seen for this long has stopped (its host is gone, or its task ended uncleanly). */
export const WAIT_TTL_MS = 120_000
/** How often a waiting job looks again, and how often an in-process holder says it still runs. */
export const SLOT_POLL_MS = 5000
/** After the file was removed: more than the longest gap between a running job's looks (a background poll, 15 s). */
export const SETTLE_MS = 30_000
/** Set in a slot job's environment to its claim id: heavy work it starts itself is part of it and never queues again. */
export const SLOT_ENV = 'ULTIMATE_SLOT'
/**
 * The TMPDIR whose queue a process joins when its own TMPDIR is private: the lander gives each check a fresh one, and
 * the CI gate's local fallback, run as a check, must still queue with everyone else (review of #206919).
 */
export const SLOT_TMPDIR_ENV = 'ULTIMATE_SLOT_TMPDIR'
/** Where the machine's queue lives for this process. */
export const queueTmpdir = () => process.env[SLOT_TMPDIR_ENV] ?? tmpdir()

const order = (a: Pick<SlotClaim, 'at' | 'id'>, b: Pick<SlotClaim, 'at' | 'id'>) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const claimOf = ({ id, kind, at, label, from }: SlotClaim): SlotClaim => ({
  id,
  kind,
  at,
  label,
  from,
})
const holding = (entry: SlotEntry): entry is Holding => entry.state !== 'waiting'

/** The queue after `event`. A late `wait` never takes the slot from a job that holds it. */
export function slotStep(queue: SlotQueue, event: SlotEvent): SlotQueue {
  const others = (id: string) => queue.entries.filter((entry) => entry.id !== id)
  switch (event.type) {
    case 'wait': {
      const found = queue.entries.find((entry) => entry.id === event.claim.id)
      if (found && holding(found)) return queue
      return {
        ...queue,
        entries: [
          ...others(event.claim.id),
          { ...claimOf(event.claim), state: 'waiting', seen: event.now },
        ],
      }
    }
    case 'start': {
      const found = queue.entries.find((entry) => entry.id === event.claim.id)
      const entry: Holding =
        found && holding(found)
          ? { ...found, holder: event.holder }
          : event.claim.kind === 'heavy'
            ? { ...claimOf(event.claim), state: 'running', since: event.now, holder: event.holder }
            : {
                ...claimOf(event.claim),
                state: 'measuring',
                since: event.now,
                until: event.now + PROBATION_MS,
                holder: event.holder,
              }
      return { ...queue, entries: [...others(event.claim.id), entry] }
    }
    case 'heavy': {
      const found = queue.entries.find((entry) => entry.id === event.claim.id)
      const since = found && holding(found) ? found.since : event.now
      return {
        ...queue,
        entries: [
          ...others(event.claim.id),
          { ...claimOf(event.claim), state: 'running', since, holder: event.holder },
        ],
      }
    }
    case 'release':
      return queue.entries.some((entry) => entry.id === event.id)
        ? { ...queue, entries: others(event.id) }
        : queue
    case 'expire': {
      // A probation its owner stopped deciding (its host is gone) ends like a waiter that stopped looking.
      const entries = queue.entries.filter((entry) =>
        entry.state === 'waiting'
          ? event.now - entry.seen <= WAIT_TTL_MS
          : event.alive(entry.holder) &&
            (entry.state === 'running' || event.now - entry.until <= WAIT_TTL_MS),
      )
      const settled = queue.settleUntil !== undefined && queue.settleUntil <= event.now
      if (entries.length === queue.entries.length && !settled) return queue
      return settled ? { entries } : { ...queue, entries }
    }
    default:
      return event satisfies never
  }
}

/** Where a job stands. */
type SlotTurn =
  /** Its turn: nothing else runs, nobody earlier waits, and the queue is settled. */
  | { kind: 'next' }
  /**
   * It waits behind the jobs that hold a place (`holders`, running or on probation) and the earlier waiters `ahead`.
   * `limit`: how many heavy jobs the machine runs at once.
   */
  | { kind: 'behind'; holders: Holding[]; ahead: SlotClaim[]; limit: number }
  /** The file was removed lately: nobody gets the slot before `until`. */
  | { kind: 'settling'; until: number }

/**
 * Where `claim` stands in `queue` (expired already): the one derivation every reader uses. A job waits while `limit`
 * jobs hold a place (running, or on probation) and behind every job that asked earlier, whatever its kind: an unknown
 * job's probation takes a place too, since it may turn out heavy and cannot be un-started then (#227574: three wrapper
 * scripts allowed beside each other by load alone ran together, load 8.1 and CPU pressure 58 % on 6 cores).
 */
export function slotTurn(
  queue: SlotQueue,
  claim: Pick<SlotClaim, 'id' | 'at'>,
  now: number,
  limit = 1,
): SlotTurn {
  if (queue.entries.some((entry) => entry.id === claim.id && holding(entry)))
    return { kind: 'next' }
  const others = queue.entries.filter((entry) => entry.id !== claim.id)
  const holders = others.filter(holding)
  const ahead = others
    .filter((entry) => entry.state === 'waiting')
    .filter((entry) => order(entry, claim) < 0)
    .toSorted(order)
    .map(claimOf)
  if (holders.length >= limit || ahead.length) return { kind: 'behind', holders, ahead, limit }
  if (queue.settleUntil !== undefined && queue.settleUntil > now)
    return { kind: 'settling', until: queue.settleUntil }
  return { kind: 'next' }
}

/** What a look at the queue gave a job. */
type SlotEntered =
  /** It holds the slot: `start` ran under the lock; `forced` when it started under load it waited out in vain. */
  | { kind: 'started'; holder: SlotHolder; forced?: Extract<CpuGate, { kind: 'forced' }> }
  /** It waits: behind other jobs, or for the queue to settle. */
  | { kind: 'waiting'; turn: Exclude<SlotTurn, { kind: 'next' }> }
  /** Its turn, but RAM would drop below the floor. */
  | { kind: 'ram'; short: RamShort }
  /**
   * Its turn, but the load is too high. `pressureSince`: set while the queue runs nothing, so the load is not its own,
   * to since when it has waited for that; its owner keeps it for its next look, and after `PRESSURE_WAIT_MS` of it the
   * job starts anyway.
   */
  | { kind: 'cpu'; gate: Extract<CpuGate, { kind: 'wait' }>; pressureSince: number | undefined }

/**
 * Folders this process saw a queue file in: one missing there later was removed. Only a process that saw it can tell a
 * removed file from a first use, so a host that starts after the removal settles nothing (extensions/memory/README.md).
 */
const seen = new Set<string>()
const file = (dir: string) => join(dir, 'slot.json')

/** The queue on disk; `removed` when this process saw it before and it is gone (or torn) now. */
async function read(dir: string, now: number) {
  const saved = await readJson<SlotQueue | undefined>(file(dir), undefined).catch(
    // A torn or foreign file holds no queue; every job says again where it stands at its next look.
    () => undefined,
  )
  if (saved && Array.isArray(saved.entries)) {
    seen.add(dir)
    return { queue: saved, removed: false }
  }
  return seen.has(dir)
    ? { queue: { entries: [], settleUntil: now + SETTLE_MS }, removed: true }
    : { queue: { entries: [] }, removed: false }
}
const alive = (holder: SlotHolder) => identify(holder.pid) === holder.identity

/** Run `change` on the expired queue under the lock and write what it returns, if anything changed. */
async function update<T>(
  parent: string,
  change: (queue: SlotQueue, now: number, dir: string) => Promise<[SlotQueue, T]>,
) {
  const dir = await stateDir(parent)
  return locked(dir, async () => {
    const now = Date.now()
    const { queue: before, removed } = await read(dir, now)
    const [after, result] = await change(slotStep(before, { type: 'expire', now, alive }), now, dir)
    // A removed file is written back at once, so its settling time holds for every reader.
    if (after !== before || removed) {
      await writeJson(file(dir), after)
      seen.add(dir)
    }
    return result
  })
}

/** The load gate for job `id` at the head of `queue` (`cpuGate`), `pressureSince` its outside wait. */
async function gateFor(
  queue: SlotQueue,
  id: string,
  now: number,
  limits: SlotLimits,
  pressureSince: number,
) {
  const held = queue.entries.filter((entry) => entry.id !== id).filter(holding)
  return cpuGate(await machineLoad(), limits.cpu, now, {
    running: held.length,
    settled: held.every((entry) => now - entry.since >= LOAD_SHOWS_MS),
    ...(held.length === 0 && { outsideSince: pressureSince }),
  })
}

/** The load gate a job at the head of the line would meet now, without joining it: for a tool's answer. */
export function peekGate(limits: SlotLimits, parent = queueTmpdir()) {
  return update<CpuGate>(parent, async (queue, now) => [
    queue,
    await gateFor(queue, '', now, limits, now),
  ])
}

/** Where `claim` would stand now, with `limit` heavy jobs at once, without joining the line. */
export function peekSlot(claim: Pick<SlotClaim, 'id' | 'at'>, limit = 1, parent = queueTmpdir()) {
  return update<SlotTurn>(parent, async (queue, now) => [queue, slotTurn(queue, claim, now, limit)])
}

/** The queue now, expired: who holds a place (`running`, `measuring`) and who waits, for a reader that shows it. */
export async function readSlot(parent = queueTmpdir()) {
  const queue = await update<SlotQueue>(parent, async (found) => [found, found])
  const [load, memory] = await Promise.all([machineLoad(), memoryCap()])
  // The machine as admission sees it: load and CPU pressure, and the service's memory cap with its pressure.
  return { queue, load, memory }
}

/** What a job is admitted against: the RAM floor, CPU admission and how many heavy jobs run at once. */
export type SlotLimits = { floor: number | undefined; cpu: number | undefined; max: number }

/**
 * How many heavy jobs this machine runs at once: `heavyWork.maxJobs` in `~/.ultimate/settings.json`, a whole number of
 * at least 1, default 1. A machine setting, read at every look, so a change applies without a restart.
 */
export async function maxHeavyJobs(userHome: string) {
  return (await heavyJobsSetting(userHome)).max
}

/** `maxHeavyJobs` and, when the setting is there but not a whole number of at least 1, what to tell about it. */
export async function heavyJobsSetting(userHome: string) {
  const settings = await readSettings(userSettingsPath(userHome)).catch(
    // Unreadable settings: the setup status reports them; the default holds meanwhile.
    (): JsonObject => ({}),
  )
  const work = settings.heavyWork
  const max = work && typeof work === 'object' && !Array.isArray(work) ? work.maxJobs : undefined
  if (typeof max === 'number' && Number.isInteger(max) && max >= 1) return { max }
  return {
    max: 1,
    ...(max !== undefined && {
      warning: `heavyWork.maxJobs in ~/.ultimate/settings.json is ${JSON.stringify(max)}, not a whole number of at least 1, so the queue runs one heavy job at a time.`,
    }),
  }
}

/** This machine's limits for a job, read now. */
export async function slotLimits(userHome: string): Promise<SlotLimits> {
  const [floor, cpu, max] = await Promise.all([
    memoryFloor(userHome),
    cpuLimit(userHome),
    maxHeavyJobs(userHome),
  ])
  return { floor, cpu, max }
}

/**
 * Look at the queue for `claim`. On its turn, with RAM for `need` MiB above `floor`, `start` runs under the lock and
 * returns the process that holds the slot (a background command's leader, or this process); otherwise it waits in line.
 * With `queue: false` (a plain bash command) it starts only when nothing runs and nobody waits, and never joins the
 * line. Inside a slot job (`SLOT_ENV`) it starts at once: the job already holds the slot. With `cpu` (`cpuLimit`) it
 * also waits for the load, as long as `pressureSince` (what its last look returned) allows.
 */
export async function enterSlot(
  claim: SlotClaim,
  options: {
    limits: SlotLimits
    need: number
    start: () => SlotHolder | Promise<SlotHolder>
    queue?: boolean
    parent?: string
    pressureSince?: number
  },
): Promise<SlotEntered> {
  const { limits, need, start, queue: joins = true, parent = queueTmpdir() } = options
  if (process.env[SLOT_ENV]) return { kind: 'started', holder: await start() }
  return update<SlotEntered>(parent, async (queue, now, dir) => {
    const turn = slotTurn(queue, claim, now, limits.max)
    const wait = (result: SlotEntered): [SlotQueue, SlotEntered] => [
      joins ? slotStep(queue, { type: 'wait', claim, now }) : queue,
      result,
    ]
    if (turn.kind !== 'next') return wait({ kind: 'waiting', turn })
    const outside = !queue.entries.some((entry) => entry.id !== claim.id && holding(entry))
    const gate = await gateFor(queue, claim.id, now, limits, options.pressureSince ?? now)
    if (gate.kind === 'wait')
      return wait({
        kind: 'cpu',
        gate,
        pressureSince: outside ? (options.pressureSince ?? now) : undefined,
      })
    const short = await admitIn(dir, limits.floor, need)
    if (short) return wait({ kind: 'ram', short })
    const holder = await start()
    return [
      slotStep(queue, { type: 'start', claim, holder, now }),
      { kind: 'started', holder, ...(gate.kind === 'forced' && { forced: gate }) },
    ]
  })
}

/**
 * A running job that gave its place back is busy again: it takes a place if fewer than `limit` are held, before any
 * waiter (it runs already), and says whether it got one. Without one its owner keeps it paused: it never runs as one
 * more than the limit (#227574).
 */
export function reclaimSlot(
  claim: SlotClaim,
  holder: SlotHolder,
  limit: number,
  parent = queueTmpdir(),
) {
  if (process.env[SLOT_ENV]) return Promise.resolve(true)
  return update<boolean>(parent, async (queue, now) => {
    const held = queue.entries.filter((entry) => entry.id !== claim.id && holding(entry))
    return held.length < limit
      ? [slotStep(queue, { type: 'heavy', claim, holder, now }), true]
      : [queue, false]
  })
}

/** A running unknown job was measured above a core: it holds the slot from now on, until it is light again or ends. */
export function heavySlot(claim: SlotClaim, holder: SlotHolder, parent = queueTmpdir()) {
  if (process.env[SLOT_ENV]) return Promise.resolve()
  return update<void>(parent, async (queue, now) => [
    slotStep(queue, { type: 'heavy', claim, holder, now }),
    undefined,
  ])
}

/** Say again that `claim` runs, held by `holder`: after a removed file, this puts it back before anyone else starts. */
export function holdSlot(claim: SlotClaim, holder: SlotHolder, parent = queueTmpdir()) {
  if (process.env[SLOT_ENV]) return Promise.resolve()
  return update<void>(parent, async (queue, now) => [
    slotStep(queue, { type: 'start', claim, holder, now }),
    undefined,
  ])
}

/** Leave the queue: the job ended, gave up or was stopped. */
export function releaseSlot(id: string, parent = queueTmpdir()) {
  if (process.env[SLOT_ENV]) return Promise.resolve()
  return update<void>(parent, async (queue) => [
    slotStep(queue, { type: 'release', id }),
    undefined,
  ])
}

/** This process as a holder: for work it does itself (a lander's checks, a bash command, the CI gate's suites). */
export function thisProcess(): SlotHolder {
  return { pid: process.pid, identity: identify(process.pid)! }
}

/** While this process holds the slot for `claim`, say so every `SLOT_POLL_MS`; the returned function releases it. */
export function keepHeld(claim: SlotClaim, parent = queueTmpdir()) {
  const holder = thisProcess()
  let released = false
  // One look at a time, and none after the release: a late one would bring the slot back, held by this live process.
  let looks = Promise.resolve()
  const timer = setInterval(() => {
    looks = looks.then(() =>
      released
        ? undefined
        : holdSlot(claim, holder, parent).catch((error: unknown) =>
            // The next look says it again; a failed one only delays that.
            console.error('slot: saying the slot is held failed:', error),
          ),
    )
  }, SLOT_POLL_MS)
  timer.unref()
  return async () => {
    released = true
    clearInterval(timer)
    await looks
    await releaseSlot(claim.id, parent)
  }
}

const ordinal = (n: number) =>
  n === 1
    ? 'next'
    : `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`
const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`

/**
 * Why a job waits, in one line: "2nd in line for the heavy-work slot, behind `pnpm check` from #12 in my-app (running
 * 3 min); `pnpm test` from #14 in my-app (waiting)", RAM below the floor at the head of the line, or a queue settling.
 */
export function describeWait(entered: Exclude<SlotEntered, { kind: 'started' }>, now = Date.now()) {
  if (entered.kind === 'ram')
    return `next in line for the heavy-work slot, waiting for memory: ${describeShort(entered.short)}`
  if (entered.kind === 'cpu')
    return `next in line, waiting for CPU: ${describeLoad(entered.gate)}${entered.pressureSince !== undefined ? ` (from work the queue does not run: it starts anyway after ${minutes(PRESSURE_WAIT_MS)})` : ''}`
  const { turn } = entered
  if (turn.kind === 'settling')
    return `the heavy-work queue's file was removed; running jobs announce themselves again, so nothing starts for ${minutes(turn.until - now)}`
  const taken =
    turn.holders.length >= turn.limit
      ? `${turn.holders.length} of ${turn.limit} heavy jobs running, `
      : ''
  return `${ordinal(turn.ahead.length + 1)} in line for the heavy-work slot, ${taken}behind ${describeBehind(turn, now)}`
}

/** The jobs a job waits behind: "`pnpm check` from #12 in my-app (running 3 min); `pnpm test` from #14 in my-app (waiting)". */
export function describeBehind(turn: Extract<SlotTurn, { kind: 'behind' }>, now = Date.now()) {
  return [
    ...turn.holders.map((holder) =>
      holder.state === 'measuring'
        ? `\`${holder.label}\` from ${holder.from} (being measured, ${minutes(Math.max(0, holder.until - now))} left)`
        : `\`${holder.label}\` from ${holder.from} (running ${minutes(now - holder.since)})`,
    ),
    ...turn.ahead.slice(0, 3).map((claim) => `\`${claim.label}\` from ${claim.from} (waiting)`),
    ...(turn.ahead.length > 3 ? [`${turn.ahead.length - 3} more`] : []),
  ].join('; ')
}

/** A command's text as a queue label: its first line, at most 80 characters. */
export const slotLabel = (command: string) => {
  const line = command.trim().split('\n')[0]
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}
