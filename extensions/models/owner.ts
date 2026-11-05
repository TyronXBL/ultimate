/**
 * Who set a conversation's model, as a state machine: `ownerStep` is the only function that decides a new
 * `ModelOwner`; `setModel` (set-model.ts) stores what it returns beside the model it sets. Pure.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Fallback, ModelOwner } from './refs.ts'

type ModelRef = { provider: string; modelId: string }

/**
 * What sets a conversation's model: the user's pick in the picker (`thinkingLevel` the level it runs at), a switch off a
 * model with no login here (`from`, `provider/modelId`) to `to`, or, with no login to switch to, the question to the user
 * about `from`, which leaves the model as it is.
 */
export type ModelEvent =
  | { type: 'pick'; model: ModelRef; thinkingLevel?: ModelThinkingLevel }
  | {
      type: 'login-fallback'
      from: string
      to: ModelRef
      reason: Exclude<Fallback['reason'], 'none'>
    }
  | { type: 'login-wait'; from: string }

/** The owner after `event`. A wait keeps the owner it found (`under`), and a wait over a wait keeps the first one's. */
export function ownerStep(state: ModelOwner, event: ModelEvent): ModelOwner {
  if (event.type === 'pick') return { by: 'user' }
  if (event.type === 'login-fallback')
    return { by: 'login-fallback', from: event.from, reason: event.reason }
  // A copy: `state` is the stored document, which `setModel` empties before it writes the new owner.
  if (state.by !== 'login-wait') return { by: 'login-wait', from: event.from, under: { ...state } }
  return state.from === event.from ? state : { ...state, from: event.from }
}

/** The model (`provider/modelId`) whose missing login the conversation already asked the user about, if it waits on one. */
export const waitsForLogin = (owner: ModelOwner) =>
  owner.by === 'login-wait' ? owner.from : undefined
