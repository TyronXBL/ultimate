/**
 * After a billing (402) or auth (401/403) failure, no request goes out for this long: neither fixes itself between
 * tool rounds, and callers like phase ask on every round. 15 minutes caps a stuck account at four calls an hour and
 * still recovers soon after a top-up without a restart; a changed key retries at once.
 */
export const cooldownMs = 15 * 60_000

export type Pause =
  | { state: 'active' }
  | { state: 'paused'; key: string; until: number; error: string }

/** The only writer of the pause: TypeSafe rejected `key`, so it pauses for the cooldown. */
export const reject = (key: string, error: string, now: number): Pause => ({
  state: 'paused',
  key,
  until: now + cooldownMs,
  error,
})

/** The error to throw instead of sending a request with `key` at `now`: only that key, and only until the pause ends. */
export const blocked = (pause: Pause, key: string, now: number) =>
  pause.state === 'paused' && pause.key === key && now < pause.until ? pause.error : undefined
