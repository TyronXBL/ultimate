/** Where a sent answer is in its undo window: held, then sent or withdrawn for good. */
type Hold = 'held' | 'sent' | 'withdrawn'
/** What happens to a held answer: its window runs out, Send now, the page goes away, or Undo. */
type HoldEvent = 'timer' | 'now' | 'leave' | 'undo'

/** The one transition: only a held answer moves, so it is sent at most once. */
const next = (state: Hold, event: HoldEvent): Hold =>
  state !== 'held' ? state : event === 'undo' ? 'withdrawn' : 'sent'

/** The ways a page goes away: closed, reloaded or navigated (beforeunload, pagehide), or backgrounded on a phone. */
const leaving = ['beforeunload', 'pagehide', 'visibilitychange'] as const

/**
 * Holds an answer for `ms` before `send` sends it, sending it at once when the page goes away (`keepalive` then, so
 * the request outlives the page; only then, as keepalive bodies share a budget of about 64 KiB and a note can be
 * longer) and never when withdrawn by `undo`.
 *
 * The leave listeners go on here, in the same task as the user's send. Added by an effect after the card rendered
 * Undo, they missed a page left in that task (#222078): beforeunload had already fired, and the send fell to the
 * card's pagehide listener, which ran after the resume snapshot's (web/src/sdk/resume.ts) and lost a third of its
 * sends under load (#194520). Capture listeners on the target run before the others, so this pagehide runs first.
 */
export function holdAnswer(send: (keepalive: boolean) => void, ms: number) {
  let state: Hold = 'held'
  const on = (event: HoldEvent) => {
    const after = next(state, event)
    if (after === state) return
    state = after
    clearTimeout(timer)
    for (const type of leaving) window.removeEventListener(type, leave, true)
    if (after === 'sent') send(event === 'leave')
  }
  const leave = (event: Event) => {
    if (event.type !== 'visibilitychange' || document.visibilityState === 'hidden') on('leave')
  }
  const timer = setTimeout(() => on('timer'), ms)
  // visibilitychange fires on the document and bubbles to the window, where capture listeners see it first.
  for (const type of leaving) window.addEventListener(type, leave, true)
  return { now: () => on('now'), undo: () => on('undo') }
}
