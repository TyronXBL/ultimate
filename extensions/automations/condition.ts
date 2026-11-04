import type { Condition } from './types.ts'

/**
 * The context condition as a state machine over the stored `armed` flag: armed until it fires, then waiting until the
 * context drops below `above - 10`. This module is its only writer; everyone else reads `conditionLook`.
 */
type ConditionLook = 'armed' | 'waiting'

export const conditionLook = (condition: Condition): ConditionLook =>
  condition.armed ? 'armed' : 'waiting'

type ConditionEvent =
  /** A context measurement. `createdAt` is where the pause counts from before any input. */
  | { type: 'measured'; percent: number; now: number; createdAt: number }
  /** The user's input to the watched conversation. */
  | { type: 'input'; at: number }

/** What a measurement asks the caller to do: fire, after `paused` ms without the user's input if it waits for one. */
type ConditionFire = { paused?: number }

/** The condition after `event`, and the fire it calls for; the caller fires, and stores the returned condition. */
export function step(
  condition: Condition,
  event: ConditionEvent,
): { condition: Condition; fire?: ConditionFire } {
  if (event.type === 'input')
    return { condition: condition.idleFor ? { ...condition, inputAt: event.at } : condition }
  const { percent, now, createdAt } = event
  const next: Condition = { ...condition, value: percent }
  if (percent < condition.above - 10) next.armed = true
  const paused = condition.idleFor ? now - (condition.inputAt ?? createdAt) : undefined
  if (
    percent >= condition.above &&
    next.armed &&
    (paused === undefined || paused >= condition.idleFor!) &&
    // A manual run is not a crossing: the cooldown counts from the condition's own fire.
    (condition.firedAt === undefined || now - condition.firedAt >= condition.cooldownMs)
  )
    return {
      condition: { ...next, armed: false, firedAt: now },
      fire: paused === undefined ? {} : { paused },
    }
  return { condition: next }
}

/**
 * The condition a create or update asks for. An armed condition stays armed or waiting through an edit; a new one
 * starts armed. Another target's input says nothing about the new one, so its pause counts afresh, from `now`.
 */
export function editCondition(
  previous: Condition | undefined,
  args: Pick<Condition, 'metric' | 'of' | 'above'> & Partial<Condition>,
  now: number,
): Condition {
  const next: Condition = {
    ...previous,
    ...args,
    cooldownMs: args.cooldownMs ?? previous?.cooldownMs ?? 3600000,
    armed: previous?.armed ?? true,
  }
  if (!next.idleFor) {
    delete next.idleFor
    delete next.inputAt
  } else if (previous !== undefined && previous.of !== next.of) next.inputAt = now
  return next
}
