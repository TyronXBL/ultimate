/**
 * The heavy-work queue as the dashboard shows it: the jobs that hold a place, then the line in order, each waiter with
 * why it waits. It reads the queue through `lib/slot.ts`'s own reader (`readSlot`), the line's order and the reasons
 * through the admission's own derivations (`peekGate`, `checkRam`), never the file.
 */
import type { CpuGate } from '../../lib/cpu.ts'
import type { RamShort } from '../../lib/memory.ts'
import type { SlotEntry, SlotQueue } from '../../lib/slot.ts'
import type { QueueJob, WaitReason } from './refs.ts'

type Holding = Extract<SlotEntry, { state: 'running' | 'measuring' }>
const holding = (entry: SlotEntry): entry is Holding => entry.state !== 'waiting'
/** The line's order, as `lib/slot.ts` keeps it: who asked first, then by id. */
const order = (a: SlotEntry, b: SlotEntry) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** "#202077 in ultimate", "the landing of #12 in my-app" → its project and conversation. */
export function fromOf(from: string) {
  const found = /#(\d+) in ([^\s()]+)/.exec(from)
  return found ? { conversation: Number(found[1]), project: found[2] } : {}
}

/** The jobs that hold a place, running or on probation. */
export const holdersOf = (queue: SlotQueue) => queue.entries.filter(holding)

/** What the first waiter meets when a place is free, each from its admission. */
export type QueueFacts = {
  now: number
  /** How many heavy jobs run at once (`heavyWork.maxJobs`). */
  places: number
  /** The load gate it would meet (`peekGate`). */
  gate?: CpuGate
  /** What memory it falls short by, under the floor or the service's cap (`checkRam`). */
  short?: RamShort
  /** CPU and memory of a holder's processes, by its job id. */
  usage: Map<string, { cpu: number; rssMiB: number }>
}

/** Why the first waiter has not started: the queue settling, every place taken, then CPU and memory admission. */
function headReason(queue: SlotQueue, held: number, facts: QueueFacts): WaitReason {
  if (queue.settleUntil !== undefined && queue.settleUntil > facts.now)
    return { kind: 'settling', until: queue.settleUntil }
  if (held >= facts.places) return { kind: 'full', running: held, places: facts.places }
  if (facts.gate?.kind === 'wait') {
    const { load, cores, pressure, below } = facts.gate
    return {
      kind: 'cpu',
      load,
      cores,
      pressure,
      belowLoad: below.load,
      ...(below.pressure !== undefined && { belowPressure: below.pressure }),
    }
  }
  const short = facts.short
  if (short?.kind === 'floor')
    return {
      kind: 'ram',
      availableMiB: short.available,
      needMiB: short.need,
      floorMiB: short.floor,
      ...(short.reserved && { reservedMiB: short.reserved }),
    }
  if (short?.kind === 'cap')
    return {
      kind: 'cap',
      usedMiB: short.used,
      highMiB: short.high,
      needMiB: short.need,
      ...(short.reserved && { reservedMiB: short.reserved }),
    }
  return { kind: 'next' }
}

/** The queue, holders first, then the waiters in order with their reasons. */
export function queueView(queue: SlotQueue, facts: QueueFacts): QueueJob[] {
  const holders = holdersOf(queue).toSorted(order)
  const waiters = queue.entries.filter((entry) => entry.state === 'waiting').toSorted(order)
  const held: QueueJob[] = holders.map((job) => {
    const usage = facts.usage.get(job.id)
    return {
      id: job.id,
      label: job.label,
      from: job.from,
      ...fromOf(job.from),
      at: job.at,
      ...(job.state === 'measuring'
        ? { state: 'measuring', since: job.since, until: job.until }
        : // An unknown command that runs was measured heavy: it holds its place like a known one.
          {
            state: 'running',
            since: job.since,
            ...(job.kind === 'unknown' && { observed: true }),
          }),
      ...(usage && { cpu: usage.cpu, rssMiB: usage.rssMiB }),
    }
  })
  const waiting: QueueJob[] = waiters.map((job, index) => ({
    id: job.id,
    label: job.label,
    from: job.from,
    ...fromOf(job.from),
    at: job.at,
    state: 'waiting',
    position: index + 1,
    reason:
      index > 0
        ? { kind: 'behind', label: waiters[index - 1].label, from: waiters[index - 1].from }
        : headReason(queue, holders.length, facts),
  }))
  return [...held, ...waiting]
}
