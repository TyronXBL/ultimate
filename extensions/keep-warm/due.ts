/** When a keep-warm ping is due, and the document's state. Browser-safe: the chip reads the hour too. */
import type { Ping, WarmDocState, WarmState } from './refs.ts'

/** Claude's long prompt cache lives an hour from the last request that read or wrote it. */
export const TTL = 60 * 60_000
/** Ping this long after the last request: late enough to be rare, early enough to land before the hour ends. */
export const LEAD = 55 * 60_000
/** No ping once the user has been away this long. */
export const IDLE_STOP = 8 * 60 * 60_000

export type Activity = {
  now: number
  /** The latest request on @ultimate's cache: its last answer or the last ping (ms). */
  lastRequest?: number
  /** The user's latest input (ms). */
  inputAt?: number
  /** A ping failed after this request: none again until a newer one. */
  failedAfter?: number
}

/** A ping failed at `failedAt` and no request renewed the cache since: a newer cached answer supersedes the failure. */
export const failing = (failedAt: number | undefined, lastRequest: number | undefined) =>
  failedAt !== undefined && (lastRequest === undefined || failedAt >= lastRequest)

/**
 * Whether to ping now: the cache is still warm but about to expire, the user wrote within `IDLE_STOP`, and no ping
 * failed since the last request. A cache already past its hour is cold; a ping would only pay to rebuild it.
 */
export function due({ now, lastRequest, inputAt, failedAfter }: Activity) {
  if (lastRequest === undefined || inputAt === undefined) return false
  if (failing(failedAfter, lastRequest)) return false
  const age = now - lastRequest
  return age >= LEAD && age < TTL && now - inputAt < IDLE_STOP
}

/** A ping claimed before it is sent, so a crash mid-request leaves it as this error: a failure, never a retry. */
const INTERRUPTED = 'interrupted'

/** Whether the user left keep-warm on (the default). */
export const isOn = (doc: Pick<WarmDocState, 'off'>) => !doc.off

/** A ping's outcome: answered, or failed with an error (a claimed one still in flight or crashed reads as failed). */
export const outcome = (ping: Ping): 'succeeded' | 'failed' => (ping.error ? 'failed' : 'succeeded')

/** The last ping did not succeed and nothing renewed the cache since: a later cached answer from @ultimate clears it. */
export const pingFailed = ({ last, lastRequest }: Pick<WarmState, 'last' | 'lastRequest'>) =>
  last !== undefined && outcome(last) !== 'succeeded' && failing(last.at, lastRequest)

/** The status-line chip's look: one derivation for the colour and the attribute. */
export const chipOf = (state: WarmState, now: number): 'off' | 'warm' | 'cold' | 'failing' =>
  !state.on
    ? 'off'
    : pingFailed(state)
      ? 'failing'
      : state.lastRequest !== undefined && state.lastRequest + TTL > now
        ? 'warm'
        : 'cold'

export type WarmEvent =
  /** The tick claims an attempt at `at`, unless the switch is off or another attempt was recorded since `previous`. */
  | { type: 'claim'; at: number; provider: string; model: string; previous?: number }
  /** An attempt ended (or was skipped). */
  | { type: 'record'; ping: Ping }
  /** The user wrote to @ultimate (ms). */
  | { type: 'input'; at: number }
  /** The user turned keep-warm on or off. */
  | { type: 'switch'; on: boolean }

/** The only writer of the keep-warm document. Whether the event applied: only a claim can be refused. */
export function warmStep(doc: WarmDocState, event: WarmEvent) {
  switch (event.type) {
    case 'claim':
      if (!isOn(doc) || doc.last?.at !== event.previous) return false
      doc.last = { at: event.at, provider: event.provider, model: event.model, error: INTERRUPTED }
      doc.pings = (doc.pings ?? 0) + 1
      return true
    case 'record':
      doc.last = event.ping
      return true
    case 'input':
      doc.inputAt = event.at
      return true
    case 'switch':
      if (event.on) delete doc.off
      else doc.off = true
      return true
    default:
      return event satisfies never
  }
}
