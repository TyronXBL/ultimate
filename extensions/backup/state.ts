/**
 * Decisions for the backup view derived from the conversation's model owner. `backupStep` and `backupOrder` keep their
 * pure decision contract; the owner stores the record. Pure: time and logins come in as arguments.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { BackupRecord, ModelOwner } from '../models/refs.ts'
import type { BackupState, ModelRef } from './refs.ts'

/** The backup state of a conversation whose owner keeps `record` (`ModelsApi.backup`), or none. */
export const backupOf = (record: BackupRecord | undefined): BackupState =>
  record ? { kind: 'backup', ...record } : { kind: 'primary' }

/**
 * Whether `legacy`, a `backup.state` record from before backups were an owner state, still holds: the conversation still
 * runs on that backup and nobody decided its model since (a pick, a wait for a login). Can go once no host has one.
 */
export const legacyHolds = (
  legacy: BackupState,
  owner: ModelOwner,
  current: ModelRef | undefined,
): legacy is BackupState & { kind: 'backup' } =>
  legacy.kind === 'backup' &&
  (owner.by === 'default' || owner.by === 'login-fallback') &&
  current !== undefined &&
  name(current) === name(legacy.to)

export const name = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`
/** A copy of the model alone, so a stored value never shares objects with the document it replaces. */
const plain = (ref: ModelRef): ModelRef => ({ provider: ref.provider, modelId: ref.modelId })

/** Minutes a conversation stays on a backup before a run that starts later puts its primary back. */
export const COOLDOWN_MINUTES = 30
const COOLDOWN = COOLDOWN_MINUTES * 60_000

/**
 * A legacy document's complete record is a backup; an empty or incomplete one is on its primary.
 */
export function fromLegacy(value: Partial<BackupRecord>): BackupState {
  const { primary, to, since, tried, thinking } = value
  if (!primary || !to || since === undefined) return { kind: 'primary' }
  return {
    kind: 'backup',
    primary,
    to,
    since,
    tried: tried ?? [],
    // Legacy records kept no limit.
    reason: value.reason ?? 'limit',
    ...(thinking ? { thinking } : {}),
  }
}

type Candidate = ModelRef & { thinking?: ModelThinkingLevel }

/** A limit answered by `failed`, to a conversation on `current` (at `currentThinking`). */
type Limit = {
  type: 'limit'
  current: ModelRef
  currentThinking?: ModelThinkingLevel
  failed: string
  reason: string
  candidates: Candidate[]
  hasLogin: (ref: ModelRef) => boolean
  now: number
}
/** A run starting at `now`. */
type Run = {
  type: 'run'
  now: number
  hasPrimaryLogin: (ref: ModelRef) => boolean
}

/**
 * What an event did, beside the new state: `none` changed nothing (a failure that is not this model's, no backup left,
 * no record, or a backup kept for the cooldown or until the primary has a login); `earlier` is a limit of a model
 * already switched away from; `switched` runs on `to` at `level`; `returned` puts `primary` back.
 */
export type BackupOutcome =
  | { kind: 'none' | 'earlier' }
  | { kind: 'switched'; from: string; to: Candidate; level?: ModelThinkingLevel; reason: string }
  | {
      kind: 'returned'
      primary: ModelRef
      thinking?: ModelThinkingLevel
      from: string
      to: string
    }

/**
 * The models a conversation on `current` would move to, in order, were it and each model after it to answer with a
 * limit: the backups `backupStep` takes one by one, then the primary it switched away from once a run would return to
 * it. Switches nothing: for work that has to get around a limit without moving the conversation, such as a summary.
 */
export function backupOrder(
  state: BackupState,
  event: Pick<Limit, 'current' | 'currentThinking' | 'candidates' | 'hasLogin' | 'now'>,
): Candidate[] {
  const order: Candidate[] = []
  let at = state
  let current: ModelRef = event.current
  for (;;) {
    const step = backupStep(at, {
      ...event,
      type: 'limit',
      current,
      failed: name(current),
      reason: '',
    })
    if (step.outcome.kind !== 'switched') break
    const { to, level } = step.outcome
    order.push({ ...plain(to), ...(level ? { thinking: level } : {}) })
    at = step.state
    current = to
  }
  const { outcome } = backupStep(state, {
    type: 'run',
    now: event.now,
    hasPrimaryLogin: event.hasLogin,
  })
  if (outcome.kind === 'returned' && !order.some((ref) => name(ref) === outcome.to))
    order.push({
      ...plain(outcome.primary),
      ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
    })
  return order
}

/**
 * The state after `event` and what happened. Every other model writer goes through the owner, which drops the backup,
 * so a conversation on a backup runs on its `to`.
 */
export function backupStep(
  state: BackupState,
  event: Limit | Run,
): { state: BackupState; outcome: BackupOutcome } {
  if (event.type === 'run') {
    if (state.kind === 'primary') return { state, outcome: { kind: 'none' } }
    if (event.now < state.since + COOLDOWN || !event.hasPrimaryLogin(state.primary))
      return { state, outcome: { kind: 'none' } }
    return {
      state: { kind: 'primary' },
      outcome: {
        kind: 'returned',
        primary: state.primary,
        ...(state.thinking ? { thinking: state.thinking } : {}),
        from: name(state.to),
        to: name(state.primary),
      },
    }
  }
  const { current, failed } = event
  const tried = state.kind === 'backup' ? state.tried : []
  // A switch made after this response was asked for: the conversation already left the model that failed here.
  if (failed !== name(current))
    return { state, outcome: { kind: tried.includes(failed) ? 'earlier' : 'none' } }
  const used = new Set([...tried, failed])
  const to = event.candidates.find(
    (candidate) => !used.has(name(candidate)) && event.hasLogin(candidate),
  )
  if (!to) return { state, outcome: { kind: 'none' } }
  // The first switch keeps the primary; the next one keeps the primary the conversation came from.
  const thinking = state.kind === 'backup' ? state.thinking : event.currentThinking
  const level = to.thinking ?? thinking
  return {
    state: {
      kind: 'backup',
      primary: plain(state.kind === 'backup' ? state.primary : current),
      to: plain(to),
      since: event.now,
      tried: [...tried, failed],
      reason: event.reason,
      ...(thinking ? { thinking } : {}),
    },
    outcome: {
      kind: 'switched',
      from: failed,
      to,
      reason: event.reason,
      ...(level ? { level } : {}),
    },
  }
}
