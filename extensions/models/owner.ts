/**
 * Who set a conversation's model, as a state machine: `ownerStep` is the only function that decides a new
 * `ModelOwner`; `setModel` (set-model.ts) stores what it returns beside the model it sets. Pure.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { BackupRecord, ModelOwner, SwitchReason } from './refs.ts'

type ModelRef = { provider: string; modelId: string }

/**
 * What sets a conversation's model: the user's pick in the picker (`thinkingLevel` the level it runs at), a switch off a
 * model with no login here (`from`, `provider/modelId`) to `to`, or, with no login to switch to, the question to the user
 * about `from`, which leaves the model as it is.
 */
export type ModelEvent =
  | { type: 'pick'; model: ModelRef; thinkingLevel: ModelThinkingLevel }
  | { type: 'login-fallback'; from: string; to: ModelRef; reason: SwitchReason }
  | { type: 'login-wait'; from: string }
  | { type: 'backup'; record: BackupRecord; level?: ModelThinkingLevel }
  | { type: 'return' }
  /** Reconcile writers outside the owner; remove when batch 3 routes subagents, lineage and core `/configure` through `setModel`. */
  | { type: 'backup-left' }

/** The owner after `event`. A wait keeps the owner it found (`under`), and a wait over a wait keeps the first one's. */
export function ownerStep(state: ModelOwner, event: ModelEvent): ModelOwner {
  if (event.type === 'pick') return { by: 'user' }
  if (event.type === 'login-fallback')
    return { by: 'login-fallback', from: event.from, reason: event.reason }
  if (event.type === 'backup') {
    // A chain of backups keeps the owner the first one found.
    const found = state.by === 'login-wait' ? state.under : state
    const { primary, thinking, to, since, tried } = event.record
    return {
      by: 'backup',
      primary: { provider: primary.provider, modelId: primary.modelId },
      ...(thinking ? { thinking } : {}),
      to: { provider: to.provider, modelId: to.modelId },
      since,
      tried: [...tried],
      under: found.by === 'backup' ? found.under : found,
    }
  }
  if (event.type === 'return' || event.type === 'backup-left')
    return state.by === 'backup' ? state.under : state
  return {
    by: 'login-wait',
    from: event.from,
    under: state.by === 'login-wait' ? state.under : state,
  }
}

/** The model (`provider/modelId`) whose missing login the conversation already asked the user about, if it waits on one. */
export const waitsForLogin = (owner: ModelOwner) =>
  owner.by === 'login-wait' ? owner.from : undefined
