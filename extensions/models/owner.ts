/**
 * Who set a conversation's model, as a state machine: `ownerStep` is the only function that decides a new
 * `ModelOwner`; `setModel` (set-model.ts) stores what it returns beside the model it sets. Pure.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { BackupRecord, ModelOwner, SwitchReason, WaitRecord } from './refs.ts'

type ModelRef = { provider: string; modelId: string }

/**
 * What sets a conversation's model: its creator, the model it starts on (a subagent's definition or caller, a standing
 * agent's pin, a branch's given model; a level left out stays as it is); the user's pick in the picker (`thinkingLevel`
 * the level it runs at). Both name the family it runs as (`definitionFamily` in lib/agents.ts, the picked family),
 * null or left out for none, since two families can share a model and the model alone never says which (#550837). A
 * switch off a model with no login here (`from`, `provider/modelId`) to `to`, or, with no
 * login to switch to, the question to the user about `from`, which leaves the model as it is; a switch to a backup
 * after a limit; a wait on the primary when no backup could take a limit; and the return to its primary, which also ends
 * a wait.
 */
export type ModelEvent =
  | {
      type: 'start'
      model: ModelRef | null
      thinkingLevel?: ModelThinkingLevel | null
      family?: string | null
    }
  | { type: 'pick'; model: ModelRef; thinkingLevel: ModelThinkingLevel; family?: string | null }
  | { type: 'login-fallback'; from: string; to: ModelRef; reason: SwitchReason }
  | { type: 'login-wait'; from: string }
  | { type: 'backup'; record: BackupRecord; level?: ModelThinkingLevel }
  | { type: 'wait'; record: WaitRecord }
  | { type: 'return' }

/** The owner beneath a wait for a login. */
const beneath = (owner: ModelOwner) => (owner.by === 'login-wait' ? owner.under : owner)

/** The backup the conversation runs on, also while it waits for that backup's login, if it runs on one. */
export function backupIn(owner: ModelOwner) {
  const found = beneath(owner)
  return found.by === 'backup' ? found : undefined
}

/** The wait on its primary after a limit, if the conversation waits on one. */
export function limitWaitIn(owner: ModelOwner) {
  const found = beneath(owner)
  return found.by === 'limit-wait' ? found : undefined
}

/**
 * The owner after `event`. A wait keeps the owner it found (`under`), and a wait over a wait keeps the first one's; a
 * backup or a limit wait keeps the owner it replaced, also through a chain of backups and waits and a wait for a login.
 */
export function ownerStep(state: ModelOwner, event: ModelEvent): ModelOwner {
  if (event.type === 'start' || event.type === 'pick') {
    const by = event.type === 'start' ? 'default' : 'user'
    return event.family ? { by, family: event.family } : { by }
  }
  if (event.type === 'login-fallback')
    return { by: 'login-fallback', from: event.from, reason: event.reason }
  if (event.type === 'backup' || event.type === 'wait') {
    const found = beneath(state)
    const under = found.by === 'backup' || found.by === 'limit-wait' ? found.under : found
    const { primary, thinking, since, tried, reason } = event.record
    const shared = {
      primary: { provider: primary.provider, modelId: primary.modelId },
      ...(thinking ? { thinking } : {}),
      since,
      tried: [...tried],
      reason,
    }
    if (event.type === 'wait')
      return {
        by: 'limit-wait',
        ...shared,
        until: event.record.until,
        attempt: event.record.attempt,
        under,
      }
    const { to, wait } = event.record
    return {
      by: 'backup',
      ...shared,
      to: { provider: to.provider, modelId: to.modelId },
      ...(wait ? { wait: { since: wait.since, attempt: wait.attempt } } : {}),
      under,
    }
  }
  if (event.type === 'return') return (backupIn(state) ?? limitWaitIn(state))?.under ?? state
  return {
    by: 'login-wait',
    from: event.from,
    under: state.by === 'login-wait' ? state.under : state,
  }
}

/**
 * The family the conversation runs as, as its creator or the user's pick named it; also while it waits for a login, which
 * keeps the model. None on a backup, a limit wait or a login fallback, which run another model than the family's: the
 * family comes back with the owner underneath when it returns.
 */
export function familyIn(owner: ModelOwner) {
  const found = beneath(owner)
  return found.by === 'default' || found.by === 'user' ? found.family : undefined
}

/** The model (`provider/modelId`) whose missing login the conversation already asked the user about, if it waits on one. */
export const waitsForLogin = (owner: ModelOwner) =>
  owner.by === 'login-wait' ? owner.from : undefined
