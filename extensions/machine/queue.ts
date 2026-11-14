/**
 * The heavy-work queue as the dashboard shows it: the jobs that hold a place, then the line in order, each waiter with
 * why it waits. It reads the queue through `lib/slot.ts`'s own reader (`readSlot`), the line's order and the reasons
 * through the admission's own derivations (`order`, `peekEntry`), never the file.
 */
import { holding, order } from '../../lib/slot.ts'
import type { SlotPeek, SlotQueue } from '../../lib/slot.ts'
import type { QueueJob, WaitReason } from './refs.ts'

/** "#202077 in ultimate", "the landing of #12 in my-app" → its project and conversation. */
export function fromOf(from: string) {
  const found = /#(\d+) in ([^\s()]+)/.exec(from)
  return found ? { conversation: Number(found[1]), project: found[2] } : {}
}

/** The jobs that hold a place, running or on probation. */
export const holdersOf = (queue: SlotQueue) => queue.entries.filter(holding)

/** What the first waiter meets when a place is free, each from its admission. */
export type QueueFacts = {
  /** How many heavy jobs run at once (`heavyWork.maxJobs`). */
  places: number
  /** What its own look would give it (`peekEntry`), taken only while a place is free. */
  head?: SlotPeek
  /** CPU and memory of a holder's processes, by its job id. */
  usage: Map<string, { cpu: number; rssMiB: number }>
}

/** Why the first waiter has not started: the queue settling, every place taken, then CPU and memory admission. */
function headReason(held: number, { head, places }: QueueFacts): WaitReason {
  // No look while every place is taken, or one that found them taken since: its own count is the current one.
  if (!head || head.kind === 'waiting')
    return head?.turn.kind === 'settling'
      ? { kind: 'settling', until: head.turn.until }
      : { kind: 'full', running: head?.turn.holders.length ?? held, places }
  if (head.kind === 'cpu') {
    const { load, cores, pressure, below, settling } = head.gate
    return {
      kind: 'cpu',
      load,
      cores,
      pressure,
      belowLoad: below.load,
      ...(below.pressure !== undefined && { belowPressure: below.pressure }),
      ...(settling && { settling: true }),
    }
  }
  if (head.kind === 'free') return { kind: 'next' }
  const { short } = head
  if (short.kind === 'floor')
    return {
      kind: 'ram',
      availableMiB: short.available,
      needMiB: short.need,
      floorMiB: short.floor,
      ...(short.reserved && { reservedMiB: short.reserved }),
    }
  return {
    kind: 'cap',
    usedMiB: short.used,
    highMiB: short.high,
    needMiB: short.need,
    ...(short.reserved && { reservedMiB: short.reserved }),
  }
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
        : headReason(holders.length, facts),
  }))
  return [...held, ...waiting]
}
