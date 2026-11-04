/**
 * The backup record of a conversation as a state machine: `primary` (it runs on its own model) or `backup` (it
 * switched off it). `backupStep` is the only function that decides a new `BackupState`; the server stores what it
 * returns. Pure: time and logins come in as arguments.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { BackupRecord, BackupState, ModelRef } from './refs.ts'

export const name = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`
/** A copy of the model alone, so a stored value never shares objects with the document it replaces. */
const plain = (ref: ModelRef): ModelRef => ({ provider: ref.provider, modelId: ref.modelId })

/** Minutes a conversation stays on a backup before a run that starts later puts its primary back. */
export const COOLDOWN_MINUTES = 30
const COOLDOWN = COOLDOWN_MINUTES * 60_000

/**
 * Before version 2 the document held the record's fields, all optional. A complete record is a backup; an empty or
 * incomplete one (which the old code cleared at the next run) is on its primary.
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
/** A run starting at `now` on `current`. */
type Run = {
  type: 'run'
  current: ModelRef | undefined
  now: number
  hasPrimaryLogin: (ref: ModelRef) => boolean
}

/**
 * What an event did, beside the new state: `none` changed nothing (a failure that is not this model's, no backup left,
 * or no record); `earlier` is a limit of a model already switched away from; `cleared` dropped the record (a model
 * picked meanwhile, and for a limit no backup was left); `wait` keeps the backup (cooldown, or no login for the primary
 * yet); `switched` runs on `to` at `level`; `returned` puts `primary` back.
 */
export type BackupOutcome =
  | { kind: 'none' | 'earlier' | 'cleared' | 'wait' }
  | { kind: 'switched'; from: string; to: Candidate; level?: ModelThinkingLevel; reason: string }
  | {
      kind: 'returned'
      primary: ModelRef
      thinking?: ModelThinkingLevel
      from: string
      to: string
    }

/** The state after `event` and what happened. */
export function backupStep(
  state: BackupState,
  event: Limit | Run,
): { state: BackupState; outcome: BackupOutcome } {
  if (event.type === 'run') {
    if (state.kind === 'primary') return { state, outcome: { kind: 'none' } }
    const { current } = event
    // A model set by someone else (a pick, `models.fallback`) is no longer this record's to return from.
    if (!current || name(current) !== name(state.to))
      return { state: { kind: 'primary' }, outcome: { kind: 'cleared' } }
    if (event.now < state.since + COOLDOWN || !event.hasPrimaryLogin(state.primary))
      return { state, outcome: { kind: 'wait' } }
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
  // A model picked since the last switch starts afresh: it is the primary now, and nothing was tried from it.
  const picked = state.kind === 'backup' && name(state.to) !== failed
  const from: BackupState = picked ? { kind: 'primary' } : state
  const used = new Set([...(from.kind === 'backup' ? from.tried : []), failed])
  const to = event.candidates.find(
    (candidate) => !used.has(name(candidate)) && event.hasLogin(candidate),
  )
  if (!to)
    return picked
      ? { state: from, outcome: { kind: 'cleared' } }
      : { state, outcome: { kind: 'none' } }
  // The first switch keeps the primary; the next one keeps the primary the conversation came from.
  const thinking = from.kind === 'backup' ? from.thinking : event.currentThinking
  const level = to.thinking ?? thinking
  return {
    state: {
      kind: 'backup',
      primary: plain(from.kind === 'backup' ? from.primary : current),
      to: plain(to),
      since: event.now,
      tried: [...(from.kind === 'backup' ? from.tried : []), failed],
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
