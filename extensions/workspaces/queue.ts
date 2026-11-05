/**
 * The lander queue entry as a state machine. `QueueEntry` is a union on `state`; `queueEntryStep` is the only writer
 * of its state fields and `isLanding` the only reading of the state. Browser-safe.
 */
import type { Landed, LanderStep, QueueEntry } from './types.ts'

/** What changes an entry: the lander takes it, logs a step, fast-forwards it, or loses its task. */
export type QueueEvent =
  | { type: 'start'; at: number }
  | { type: 'step'; row: LanderStep }
  | { type: 'landed'; landed: Landed }
  | { type: 'reset' }

type Landing = Extract<QueueEntry, { state: 'landing' }>

/** A new submission: queued, with its first step. */
export function newQueueEntry(
  submission: Omit<Extract<QueueEntry, { state: 'queued' }>, 'state' | 'steps' | 'landed'>,
  at: number,
): QueueEntry {
  return { ...submission, state: 'queued', steps: [{ step: 'queued', at }] }
}

export const isLanding = (entry: QueueEntry): entry is Landing => entry.state === 'landing'

/** The entry without its current step, which only a landing one has. */
function withoutStep(entry: QueueEntry) {
  if (!isLanding(entry)) return entry
  const { step: _step, ...rest } = entry
  return rest
}

/**
 * The entry after `event`. A start (also of an entry a faulted task left landing) clears the stale current step; a
 * step shows only while landing; the first fast-forward decides `landed` and a reset keeps it, so a later lander task
 * reports that landing instead of merging again; a reset drops the current step.
 */
export function queueEntryStep(entry: QueueEntry, event: QueueEvent): QueueEntry {
  switch (event.type) {
    case 'start':
      return {
        ...withoutStep(entry),
        state: 'landing',
        steps: [...entry.steps, { step: 'started', at: event.at }],
      }
    case 'step': {
      const steps = [...entry.steps, event.row]
      return isLanding(entry) ? { ...entry, steps, step: event.row.step } : { ...entry, steps }
    }
    case 'landed':
      return isLanding(entry) && !entry.landed ? { ...entry, landed: event.landed } : entry
    case 'reset':
      return { ...withoutStep(entry), state: 'queued' }
    default:
      return event satisfies never
  }
}

/** Apply `event` to the entry `id` of a document draft's queue, returning the entry now stored. */
export function advance(queue: QueueEntry[], id: string, event: QueueEvent): QueueEntry {
  const index = queue.findIndex((item) => item.id === id)
  return (queue[index] = queueEntryStep(queue[index], event))
}
