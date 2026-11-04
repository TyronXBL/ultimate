/**
 * The backup record of a conversation as a state machine. A conversation is `on its primary` (no record) or `on a
 * backup` (`activeBackup` holds all of one). `decideSwitch` and `decideReturn` are the only writers of `BackupState`;
 * they change it in place and say what happened. Pure: time and logins come in as arguments.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { BackupRecord, BackupState, ModelRef } from './refs.ts'

export const name = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`

/** The record `state` holds, once it holds all of one: the one derivation every reader uses. */
export function activeBackup(state: BackupState): BackupRecord | undefined {
  const { primary, to, since, tried } = state
  if (!primary || !to || since === undefined) return undefined
  return {
    primary,
    to,
    since,
    tried: tried ?? [],
    ...(state.thinking ? { thinking: state.thinking } : {}),
  }
}

const clear = (state: BackupState) => {
  delete state.primary
  delete state.thinking
  delete state.to
  delete state.since
  delete state.tried
}

/** Minutes a conversation stays on a backup before a run that starts later puts its primary back. */
export const COOLDOWN_MINUTES = 30
const COOLDOWN = COOLDOWN_MINUTES * 60_000

type Candidate = ModelRef & { thinking?: ModelThinkingLevel }

/**
 * What a limit did: `none` changed nothing (the failure is not this model's, or no backup is left); `earlier` is a
 * failure of a model already switched away from; `cleared` dropped a stale record and found no backup; `switched`
 * recorded the switch, to run on `to` at `level`.
 */
export type SwitchStep =
  | { kind: 'none' }
  | { kind: 'earlier' }
  | { kind: 'cleared' }
  | { kind: 'switched'; from: string; to: Candidate; level?: ModelThinkingLevel; reason: string }

/**
 * A conversation on `current` (at `currentThinking`) got a limit from `failed`: take the first of `candidates` not tried
 * yet that has a login, remembering the primary to return to.
 */
export function decideSwitch(
  state: BackupState,
  event: {
    current: ModelRef
    currentThinking?: ModelThinkingLevel
    failed: string
    reason: string
    candidates: Candidate[]
    hasLogin: (ref: ModelRef) => boolean
    now: number
  },
): SwitchStep {
  const { current, failed } = event
  // A switch made after this response was asked for: the conversation already left the model that failed here.
  if (failed !== name(current)) return { kind: state.tried?.includes(failed) ? 'earlier' : 'none' }
  // A model picked since the last switch starts afresh: it is the primary now, and nothing was tried from it.
  const picked = state.to !== undefined && name(state.to) !== failed
  if (picked) clear(state)
  const used = new Set([...(state.tried ?? []), failed])
  const to = event.candidates.find(
    (candidate) => !used.has(name(candidate)) && event.hasLogin(candidate),
  )
  if (!to) return { kind: picked ? 'cleared' : 'none' }
  // The first switch keeps the primary; the next one keeps the primary the conversation came from.
  const thinking = state.primary ? state.thinking : event.currentThinking
  Object.assign(state, {
    primary: state.primary ?? current,
    to: { provider: to.provider, modelId: to.modelId },
    since: event.now,
    tried: [...(state.tried ?? []), failed],
    ...(thinking ? { thinking } : {}),
  })
  const level = to.thinking ?? thinking
  return { kind: 'switched', from: failed, to, reason: event.reason, ...(level ? { level } : {}) }
}

/**
 * What a run starting at `now` does to the record: `none` has no record; `cleared` dropped it because someone else set
 * the model; `wait` keeps the backup (cooldown, or no login for the primary yet); `returned` dropped it to put the
 * primary back.
 */
export type ReturnStep =
  | { kind: 'none' }
  | { kind: 'cleared' }
  | { kind: 'wait' }
  | {
      kind: 'returned'
      primary: ModelRef
      thinking?: ModelThinkingLevel
      from: string
      to: string
    }

export function decideReturn(
  state: BackupState,
  event: {
    current: ModelRef | undefined
    now: number
    hasPrimaryLogin: (ref: ModelRef) => boolean
  },
): ReturnStep {
  const record = activeBackup(state)
  if (!record) return { kind: 'none' }
  const { current } = event
  // A model set by someone else (a pick, `models.fallback`) is no longer this record's to return from.
  if (!current || name(current) !== name(record.to)) {
    clear(state)
    return { kind: 'cleared' }
  }
  if (event.now < record.since + COOLDOWN || !event.hasPrimaryLogin(record.primary))
    return { kind: 'wait' }
  clear(state)
  return {
    kind: 'returned',
    primary: record.primary,
    ...(record.thinking ? { thinking: record.thinking } : {}),
    from: name(record.to),
    to: name(record.primary),
  }
}
