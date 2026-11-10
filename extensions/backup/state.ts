/**
 * Decisions for the backup view derived from the conversation's model owner. `backupStep` and `backupOrder` keep their
 * pure decision contract; the owner stores the record. Pure: time, logins and what fits come in as arguments.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { BackupRecord, ModelOwner } from '../models/refs.ts'
import type { BackupState, ModelRef, Skipped } from './refs.ts'

/** The backup state of a conversation whose model owner is `owner` (`ModelsApi.owner`). */
export function backupOf(owner: ModelOwner): BackupState {
  const found = owner.by === 'login-wait' ? owner.under : owner
  if (found.by === 'backup') {
    const { by: _, under: __, ...record } = found
    return { kind: 'backup', ...record }
  }
  if (found.by === 'limit-wait') {
    const { by: _, under: __, ...record } = found
    return { kind: 'waiting', ...record }
  }
  return { kind: 'primary' }
}

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
const MINUTE = 60_000
/** The longest a conversation waits for its primary; a limit that resets later fails as before. */
const WAIT_LIMIT = 24 * 60 * MINUTE

/**
 * The minutes before the primary is tried again, at the `attempt`th wait in a row: 1, 2, 4, 8, 16, then every 30.
 */
const backoff = (attempt: number) => Math.min(2 ** (attempt - 1), 30) * MINUTE

/**
 * When a wait that begins at `now` tries the primary again: once its limit resets, when the provider said when (`reset`),
 * else after the backoff. `jitter`, from 0 up to 1, is this conversation's share of a spread (a quarter of the backoff,
 * or a minute after a reset), so conversations waiting on one limit do not all try it in the same second.
 */
export function waitUntil(now: number, attempt: number, jitter: number, reset?: number) {
  if (reset !== undefined && reset > now) return reset + Math.round(jitter * MINUTE)
  const delay = backoff(attempt)
  return now + delay + Math.round((jitter * delay) / 4)
}

/**
 * A conversation's share of the spread, from 0 up to 1, the same at every wait: conversations that wait on one limit
 * get different ones.
 */
export const jitterOf = (id: number) => ((id * 2654435761) % 2 ** 32) / 2 ** 32

/** How long a quota whose provider gave no reset time (a 402 out of credit) counts as exhausted. */
const EXHAUSTED_FOR = 60 * MINUTE

/**
 * `backup.exhausted`, on the root: the models (`provider/modelId`) this machine saw answer with an exhausted quota, and
 * until when, so no conversation tries them again before; `at` when it was seen, `error` as the provider said it.
 */
export type Exhausted = Record<string, { until: number; at: number; error: string }>

/**
 * What changes the exhausted models: a quota answer of `model`, until its provider's reset or `EXHAUSTED_FOR`; an answer
 * of `model` that is no error, which shows it has room again; a login or logout of `provider`, whose account may differ.
 */
export type ExhaustedEvent =
  | { type: 'quota'; model: string; reset?: number; error: string }
  | { type: 'answered'; model: string }
  | { type: 'login'; provider: string }

/** The exhausted models after `event` at `now`: the only writer of `backup.exhausted`. Expired ones drop out. */
export function exhaustedStep(doc: Exhausted, event: ExhaustedEvent, now: number): Exhausted {
  const next = Object.fromEntries(
    Object.entries(doc).filter(
      ([model, { until }]) =>
        until > now &&
        !(event.type === 'answered' && model === event.model) &&
        !(event.type === 'login' && model.startsWith(`${event.provider}/`)),
    ),
  )
  if (event.type === 'quota')
    next[event.model] = {
      until: event.reset !== undefined && event.reset > now ? event.reset : now + EXHAUSTED_FOR,
      at: now,
      error: event.error,
    }
  return next
}

/** Until when `model` is exhausted at `now`; undefined when it is not. */
export const exhaustedUntil = (doc: Exhausted, model: string, now: number) => {
  const until = Object.hasOwn(doc, model) ? doc[model].until : undefined
  return until !== undefined && until > now ? until : undefined
}

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
  /** Why backup `ref` cannot take the conversation now (no login, too small for it), or undefined when it can. */
  skip: (ref: ModelRef) => string | undefined
  /** When the primary's limit resets, when its provider said so. */
  reset?: number
  /** This conversation's share of the spread between waits on one limit (`jitterOf`). */
  jitter: number
  now: number
}
/** A run starting at `now`. */
type Run = {
  type: 'run'
  now: number
  hasPrimaryLogin: (ref: ModelRef) => boolean
}
/** Model `model` (`provider/modelId`) answered the conversation. */
type Answered = { type: 'answered'; model: string }

/**
 * What an event did, beside the new state: `none` changed nothing (a failure that is not this model's, no backup model
 * at all, a reset past `WAIT_LIMIT`, no record, or a backup kept for the cooldown or until the primary has a login);
 * `earlier` is a limit of a model already switched away from; `held` a limit of the primary during its wait, which
 * changes nothing; `switched` runs on `to` at `level`; `returned` puts `primary` back; `waiting` waits for the primary
 * as the new state says, every backup `skipped` and why; `gave-up` ends a wait that would outlast `WAIT_LIMIT`; `resumed` ends a wait
 * the primary answered.
 */
export type BackupOutcome =
  | { kind: 'none' | 'earlier' | 'held' | 'gave-up' | 'resumed' }
  | { kind: 'switched'; from: string; to: Candidate; level?: ModelThinkingLevel; reason: string }
  | {
      kind: 'returned'
      primary: ModelRef
      thinking?: ModelThinkingLevel
      from: string
      to: string
    }
  | { kind: 'waiting'; from: string; skipped: Skipped[] }

/**
 * The models a conversation on `current` would move to, in order, were it and each model after it to answer with a
 * limit: the backups `backupStep` takes one by one, then the primary it switched away from once a run would return to
 * it. Switches nothing: for work that has to get around a limit without moving the conversation, such as a summary.
 */
export function backupOrder(
  state: BackupState,
  event: Pick<Limit, 'current' | 'currentThinking' | 'candidates' | 'skip' | 'now'>,
): Candidate[] {
  const order: Candidate[] = []
  // A wait runs on its primary: the backups it would take are the ones a limit there takes.
  let at: BackupState = state.kind === 'waiting' ? { kind: 'primary' } : state
  let current: ModelRef = event.current
  for (;;) {
    const step = backupStep(at, {
      ...event,
      type: 'limit',
      current,
      failed: name(current),
      reason: '',
      jitter: 0,
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
    hasPrimaryLogin: (ref) => !event.skip(ref),
  })
  if (outcome.kind === 'returned' && !order.some((ref) => name(ref) === outcome.to))
    order.push({
      ...plain(outcome.primary),
      ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
    })
  return order
}

/**
 * The state after `event` and what happened. Every other model writer goes through the owner, which drops the backup or
 * the wait, so a conversation on a backup runs on its `to`, and one waiting runs on its `primary`.
 */
export function backupStep(
  state: BackupState,
  event: Limit | Run | Answered,
): { state: BackupState; outcome: BackupOutcome } {
  if (event.type === 'answered') {
    if (state.kind !== 'waiting' || event.model !== name(state.primary))
      return { state, outcome: { kind: 'none' } }
    return { state: { kind: 'primary' }, outcome: { kind: 'resumed' } }
  }
  if (event.type === 'run') {
    if (state.kind !== 'backup') return { state, outcome: { kind: 'none' } }
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
  const { current, failed, now } = event
  const waiting = state.kind === 'waiting' ? state : undefined
  // A wait's earlier chain is over once its time came: the next limit starts a new one.
  const tried = state.kind === 'primary' || (waiting && now >= waiting.until) ? [] : state.tried
  // A switch made after this response was asked for: the conversation already left the model that failed here.
  if (failed !== name(current))
    return { state, outcome: { kind: tried.includes(failed) ? 'earlier' : 'none' } }
  // The primary answered with its limit again before the wait was over: Pi's own retries, or an input meanwhile.
  if (waiting && now < waiting.until) return { state, outcome: { kind: 'held' } }
  const used = new Set([...tried, failed])
  const to = event.candidates.find(
    (candidate) => !used.has(name(candidate)) && !event.skip(candidate),
  )
  // The first switch keeps the primary; the next one keeps the primary the conversation came from.
  const primary = plain(state.kind === 'primary' ? current : state.primary)
  const thinking = state.kind === 'primary' ? event.currentThinking : state.thinking
  if (to) {
    const level = to.thinking ?? thinking
    return {
      state: {
        kind: 'backup',
        primary,
        to: plain(to),
        since: now,
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
  // Without a backup model the limit goes where it always went: the host pauses, or the run fails.
  if (event.candidates.length === 0) return { state, outcome: { kind: 'none' } }
  const attempt = waiting ? waiting.attempt + 1 : 1
  const since = waiting ? waiting.since : now
  const until = waitUntil(now, attempt, event.jitter, event.reset)
  if (until - since > WAIT_LIMIT)
    return waiting
      ? { state: { kind: 'primary' }, outcome: { kind: 'gave-up' } }
      : { state, outcome: { kind: 'none' } }
  const skipped = event.candidates.map((candidate) => ({
    model: name(candidate),
    why: used.has(name(candidate)) ? 'tried' : event.skip(candidate)!,
  }))
  return {
    state: {
      kind: 'waiting',
      primary,
      since,
      until,
      attempt,
      tried: [...tried, failed],
      reason: event.reason,
      ...(thinking ? { thinking } : {}),
    },
    outcome: { kind: 'waiting', from: failed, skipped },
  }
}
