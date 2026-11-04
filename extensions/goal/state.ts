/**
 * The goal's two state machines, written only here: its phase (active, waiting on the user, ended) and each
 * criterion (open, met, blocked after repeated failed tries). Pure: callers store what these return.
 */
import type { Criterion, Ending, Goal, GoalPhase } from './refs.ts'

/** Failed tries after which a criterion is blocked; work goes on with the others. */
export const TRIES = 3

export type GoalEvent =
  | { type: 'pause'; reason: string; at: number }
  | { type: 'resume' }
  | { type: 'end'; ending: Ending }

/** The phase after `event`; an event the phase cannot take throws, naming why. */
export function transition(phase: GoalPhase, event: GoalEvent): GoalPhase {
  if (phase.state === 'ended') throw new Error('No goal is open')
  if (event.type === 'pause') return { state: 'waiting', reason: event.reason, at: event.at }
  if (event.type === 'end') return { state: 'ended', ...event.ending }
  if (phase.state !== 'waiting') throw new Error('The goal is not paused')
  return { state: 'active' }
}

/** The open goal of `goals`, if any: at most one is not ended. */
export const openGoalOf = (goals: Goal[]) => goals.find((goal) => goal.phase.state !== 'ended')

/** What the goal's reminder automation should be: waking @ultimate, paused while the goal waits, or gone once it ended. */
export const reminderOf = (phase: GoalPhase): 'on' | 'paused' | 'off' =>
  phase.state === 'active' ? 'on' : phase.state === 'waiting' ? 'paused' : 'off'

/** The criterion after a check: met, or one more failed try, blocked once `TRIES` are used. */
export function mark(criterion: Criterion, result: 'met' | 'failed'): Criterion {
  if (result === 'met') return { ...criterion, status: 'met' }
  const tries = (criterion.tries ?? 0) + 1
  return { ...criterion, tries, status: tries >= TRIES ? 'blocked' : criterion.status }
}
