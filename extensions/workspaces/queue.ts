/**
 * The lander queue entry as a state machine. `QueueEntry` is a union on `state`; `queueEntryStep` is the only writer
 * of its state fields and readers narrow on that discriminant. Browser-safe.
 */
import type { Landed, LanderStep, QueueEntry } from './types.ts'

/** What changes an entry: the lander takes it, a step shows, its fast-forward lands, or its task ends. */
export type QueueEvent =
  | { type: 'start'; at: number }
  | { type: 'step'; row: LanderStep }
  | { type: 'landed'; landed: Landed }
  | { type: 'reset' }

/** An entry whose fast-forward is recorded. */
type LandedEntry = QueueEntry & { landed: Landed }

/** A new submission: queued, with its first step. */
export function newQueueEntry(
  submission: Omit<Extract<QueueEntry, { state: 'queued' }>, 'state' | 'steps' | 'landed'>,
  at: number,
): QueueEntry {
  return { ...submission, state: 'queued', steps: [{ step: 'queued', at }] }
}

/** The entry without its current step, which only a landing one has. */
function withoutStep(entry: QueueEntry) {
  if (entry.state === 'queued') return entry
  const { step: _step, ...rest } = entry
  return rest
}

/**
 * The entry after `event`. A start (also of an entry a faulted task left landing) clears the stale current step; the
 * first fast-forward records `landed` and a reset keeps it, so a later lander task reports that landing instead of
 * merging again; a reset drops the current step.
 */
export function queueEntryStep(
  entry: QueueEntry,
  event: { type: 'landed'; landed: Landed },
): LandedEntry
export function queueEntryStep(entry: QueueEntry, event: QueueEvent): QueueEntry
export function queueEntryStep(entry: QueueEntry, event: QueueEvent): QueueEntry {
  switch (event.type) {
    case 'start':
      return {
        ...withoutStep(entry),
        state: 'landing',
        steps: [...entry.steps, { step: 'started', at: event.at }],
      }
    case 'step':
      if (entry.state === 'queued')
        throw new Error(`Queue entry ${entry.id} is queued, not landing`)
      return { ...entry, steps: [...entry.steps, event.row], step: event.row.step }
    case 'landed':
      return entry.landed ? entry : { ...entry, landed: event.landed }
    case 'reset':
      return entry.state === 'queued' ? entry : { ...withoutStep(entry), state: 'queued' }
    default:
      return event satisfies never
  }
}

/** Apply `event` to the entry `id` of a document draft's queue, writing only a changed entry. */
export function advance(
  queue: QueueEntry[],
  id: string,
  event: { type: 'landed'; landed: Landed },
): LandedEntry
export function advance(queue: QueueEntry[], id: string, event: QueueEvent): QueueEntry
export function advance(queue: QueueEntry[], id: string, event: QueueEvent): QueueEntry {
  const slot = queue.findIndex((item) => item.id === id)
  if (slot < 0) throw new Error(`No queue entry ${id}`)
  const next = queueEntryStep(queue[slot], event)
  if (next !== queue[slot]) queue[slot] = next
  return next
}
