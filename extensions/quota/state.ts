/** One provider's cached reading and the facts that decide when to read again. */
import type { QuotaReading } from './api.ts'

const MINUTE = 60_000
/** How old numbers may get while the provider is idle; after one of its answers; when the user asks for fresh ones. */
const IDLE = 5 * MINUTE
const USED = MINUTE
const FRESH = 30_000

/** One provider's last reading, the last attempt, and its latest answer, which shortens how long the reading holds. */
export type Cached = {
  reading?: QuotaReading & { at: number }
  tried?: number
  error?: string
  used?: number
  /** A limit error after the last attempt: read again at once. */
  limitedAt?: number
  inflight?: Promise<void>
}

export type CacheEvent =
  /** A read began at `at`, running as `reading`. */
  | { type: 'start'; at: number; reading: Promise<void> }
  /** It got numbers. */
  | { type: 'read'; reading: QuotaReading; at: number }
  /** It failed, with a fixed phrase. */
  | { type: 'fail'; error: string }
  /** It ended, either way. */
  | { type: 'settle' }
  /** The provider answered a request of ours at `at`; `limited` when that was a limit error. */
  | { type: 'answer'; at: number; limited: boolean }

/** The only writer of a cache entry. */
export function cacheStep(entry: Cached, event: CacheEvent) {
  switch (event.type) {
    case 'start':
      entry.tried = event.at
      entry.inflight = event.reading
      return
    case 'read':
      entry.reading = { ...event.reading, at: event.at }
      delete entry.error
      return
    case 'fail':
      entry.error = event.error
      return
    case 'settle':
      delete entry.inflight
      return
    case 'answer':
      entry.used = event.at
      if (event.limited) entry.limitedAt = event.at
      return
    default:
      event satisfies never
  }
}

/**
 * Whether `entry` should be read again at `now`: never read, a limit hit since, or older than its allowance, which is
 * shorter after an answer from the provider or a failed read.
 */
export function due(entry: Cached, now: number, fresh: boolean) {
  if (entry.tried === undefined) return true
  if (entry.limitedAt !== undefined && entry.limitedAt > entry.tried) return true
  const allowance = fresh
    ? FRESH
    : entry.error !== undefined || (entry.used !== undefined && entry.used > entry.tried)
      ? USED
      : IDLE
  return now - entry.tried >= allowance
}
