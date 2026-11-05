/** The pause document's one writer and the derivations every reader uses. Browser-safe, pure. */
import type { Held, Pause, PauseDocState, PauseState, RateLimit } from './refs.ts'

export type PauseEvent =
  /** Hold the host at `now` with each run mid-turn (`runs`); `limit` when a rate limit asks, none when the user does. */
  | { type: 'hold'; now: number; runs: Held['runs']; limit?: RateLimit }
  | { type: 'play' }
  /** The user's setting: minutes after a rate-limit pause began that Play is pressed by itself; null is off. */
  | { type: 'autoPlay'; minutes: number | null }

export const initialPause = (): PauseDocState => ({ pause: { state: 'running' } })

/**
 * The pause after a hold. A hold during a pause attaches a missing limit, or makes the pause the user's too (`both`),
 * which never plays by itself; the first limit stays.
 */
function hold(pause: Pause, { now, runs, limit }: Extract<PauseEvent, { type: 'hold' }>): Pause {
  switch (pause.state) {
    case 'running':
      return limit
        ? { state: 'limit', limit, since: now, runs }
        : { state: 'manual', since: now, runs }
    case 'manual':
      return limit ? { ...pause, state: 'both', limit } : pause
    case 'limit':
      return limit ? pause : { ...pause, state: 'both' }
    case 'both':
      return pause
    default:
      return pause satisfies never
  }
}

/** The document after `event`. Play ends any pause and keeps the setting. */
export function pauseStep(doc: PauseDocState, event: PauseEvent): PauseDocState {
  switch (event.type) {
    case 'hold':
      return { ...doc, pause: hold(doc.pause, event) }
    case 'play':
      return { ...doc, pause: { state: 'running' } }
    case 'autoPlay': {
      const { autoPlay: _, ...rest } = doc
      return event.minutes === null ? rest : { ...rest, autoPlay: event.minutes }
    }
    default:
      return event satisfies never
  }
}

/** Whether the host is paused; false while the document is unread. */
export const isPaused = (doc: PauseDocState | null | undefined) =>
  !!doc && doc.pause.state !== 'running'

/** The pause while it holds: when it began and the runs it caught; undefined while running. */
export const heldOf = (doc: PauseDocState) =>
  doc.pause.state === 'running' ? undefined : doc.pause

/** The rate limit that paused the host, if one did. */
export const limitOf = (doc: PauseDocState) =>
  doc.pause.state === 'limit' || doc.pause.state === 'both' ? doc.pause.limit : undefined

/** When `doc`'s pause plays by itself: a rate-limit pause the user did not also pause, with the setting on. */
export const autoPlayOf = (doc: PauseDocState) =>
  doc.pause.state === 'limit' && doc.autoPlay
    ? { since: doc.pause.since, at: doc.pause.since + doc.autoPlay * 60_000, minutes: doc.autoPlay }
    : undefined

/** What the `state` action tells about `doc`, beside the tasks still running. */
export function pauseView(doc: PauseDocState): Omit<PauseState, 'running'> {
  const held = heldOf(doc)
  const limit = limitOf(doc)
  const plan = autoPlayOf(doc)
  return {
    paused: held !== undefined,
    ...(held && { since: held.since }),
    ...(limit && { limit }),
    ...(doc.autoPlay === undefined ? {} : { autoPlay: doc.autoPlay }),
    ...(plan && { autoPlayAt: plan.at }),
  }
}

/** Running; pausing while paused tasks still finish; paused once none runs. */
export const pausePhase = (state: Pick<PauseState, 'paused' | 'running'>) =>
  state.paused ? (state.running.length > 0 ? 'pausing' : 'paused') : 'running'
