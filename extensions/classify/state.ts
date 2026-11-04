/**
 * After a billing (402) or auth (401/403) failure, no request goes out for this long: neither fixes itself between
 * tool rounds, and callers like phase ask on every round. 15 minutes caps a stuck account at four calls an hour and
 * still recovers soon after a top-up without a restart; a changed key retries at once.
 */
export const cooldownMs = 15 * 60_000

export type Pause =
  | { state: 'active' }
  | { state: 'paused'; key: string; until: number; error: string }

export type PauseEvent =
  | { type: 'reject'; key: string; error: string; now: number }
  /** A request is about to go out with `key`. */
  | { type: 'ask'; key: string; now: number }

/** The only writer of the pause: a rejected key pauses; asking ends the pause once it expired or the key changed. */
export function advance(pause: Pause, event: PauseEvent): Pause {
  switch (event.type) {
    case 'reject':
      return { state: 'paused', key: event.key, until: event.now + cooldownMs, error: event.error }
    case 'ask':
      return pause.state === 'paused' && pause.key === event.key && event.now < pause.until
        ? pause
        : { state: 'active' }
    default:
      return event satisfies never
  }
}

/** The error to throw instead of sending a request, while paused. */
export const blocked = (pause: Pause) => (pause.state === 'paused' ? pause.error : undefined)
