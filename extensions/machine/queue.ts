/**
 * The heavy-work queue as the dashboard shows it: the jobs that hold the slot, then the line in order, each waiter with
 * why it waits. It reads `lib/slot.ts`'s own derivation (`slotTurn`, through `peekSlot`) for a claim at the very end of
 * the line, which lists every holder and every waiter ahead of it.
 */
import type { RamShort } from '../../lib/memory.ts'
import type { QueueJob, WaitReason } from './refs.ts'

type Claim = { id: string; at: number; label: string; from: string }
type Held = Claim & { state: string; since: number; until?: number; holder: { pid: number } }
/**
 * `peekSlot`'s answer, wide enough for both shapes of `lib/slot.ts`: today one `running` job holds the slot; with
 * #227574 `holders` lists every job that holds it, running or `measuring` (an unknown command on probation). Reading
 * both keeps this view working across that landing; drop `running` once it has landed.
 */
export type Turn = {
  kind: string
  running?: Held
  holders?: Held[]
  ahead?: Claim[]
  until?: number
}

/** The claim whose turn lists the whole queue: it asked last of all, so every waiter is ahead of it. */
export const END_OF_LINE = {
  id: 'machine:end-of-line',
  at: Number.MAX_SAFE_INTEGER,
  kind: 'heavy' as const,
}

/** The jobs that hold the slot, either shape. */
export const holdersOf = (turn: Turn) => turn.holders ?? (turn.running ? [turn.running] : [])

/** "#202077 in ultimate", "the landing of #12 in my-app" → its project and conversation. */
export function fromOf(from: string) {
  const found = /#(\d+) in ([^\s()]+)/.exec(from)
  return found ? { conversation: Number(found[1]), project: found[2] } : {}
}

export type QueueFacts = {
  now: number
  load: number
  cores: number
  /** What RAM the first waiter falls short by, per `lib/memory.ts`'s admission (`checkRam`), if it does. */
  short?: RamShort
  /** CPU and memory of a holder's processes, by its job id. */
  usage: Map<string, { cpu: number; rssMiB: number }>
}

/** The queue, holders first, then the waiters in order with their reasons. */
export function queueView(turn: Turn, facts: QueueFacts): QueueJob[] {
  const holders = holdersOf(turn)
  const ahead = turn.ahead ?? []
  const held: QueueJob[] = holders.map((job) => {
    const usage = facts.usage.get(job.id)
    return {
      id: job.id,
      label: job.label,
      from: job.from,
      ...fromOf(job.from),
      at: job.at,
      state: job.state === 'measuring' ? 'measuring' : 'running',
      since: job.since,
      ...(job.until !== undefined && { until: job.until }),
      ...(usage && { cpu: usage.cpu, rssMiB: usage.rssMiB }),
    }
  })
  const reasonAt = (index: number): WaitReason => {
    const before = index > 0 ? ahead[index - 1] : holders.at(-1)
    if (before) return { kind: 'behind', label: before.label, from: before.from }
    if (turn.kind === 'settling' && turn.until !== undefined)
      return { kind: 'settling', until: turn.until }
    if (facts.short)
      return {
        kind: 'ram',
        availableMiB: facts.short.available,
        needMiB: facts.short.need,
        floorMiB: facts.short.floor,
        ...(facts.short.reserved && { reservedMiB: facts.short.reserved }),
      }
    if (facts.load >= facts.cores) return { kind: 'load', load: facts.load, cores: facts.cores }
    return { kind: 'next' }
  }
  const waiting: QueueJob[] = ahead.map((job, index) => ({
    id: job.id,
    label: job.label,
    from: job.from,
    ...fromOf(job.from),
    at: job.at,
    state: 'waiting',
    position: index + 1,
    reason: reasonAt(index),
  }))
  return [...held, ...waiting]
}
