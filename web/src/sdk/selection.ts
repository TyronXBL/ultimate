/**
 * Which conversation the page follows and how its URL enters history. `starting` lasts until the stream's first UI
 * snapshot, where an explicit `?conversation=` wins over the saved shell; from then on the page follows
 * `shell.conversation`, and `entry` says whether the next selection pushes a history entry or replaces the current one,
 * as a redirect, a fallback or the browser's own back and forward do.
 */
export type Selection =
  | { phase: 'starting' }
  | { phase: 'following'; selected: number | undefined; entry: 'push' | 'replace' }

type Event =
  /** The first snapshot is in and the URL has won: follow `id`. */
  | { type: 'started'; id: number | undefined }
  /** `shell.conversation` now names `id`, whichever tab or action set it. */
  | { type: 'selected'; id: number | undefined }
  /** The next selection replaces the current history entry. */
  | { type: 'redirect' }
  /** The view of the chosen conversation `id` arrived: the URL names it, never the stream's fallback to the root. */
  | { type: 'shown'; id: number }

/** What the page does next: write the URL (replacing the entry or pushing one), and show a conversation. */
type Effect =
  | { type: 'url'; id: number; replace: boolean }
  | { type: 'show'; id: number | undefined }

/** The only writer of selection state. */
export function step(state: Selection, event: Event): { state: Selection; effects: Effect[] } {
  switch (event.type) {
    case 'started':
      if (state.phase !== 'starting') return { state, effects: [] }
      return {
        state: { phase: 'following', selected: event.id, entry: 'push' },
        effects: [
          ...(event.id === undefined
            ? []
            : [{ type: 'url' as const, id: event.id, replace: true }]),
          { type: 'show', id: event.id },
        ],
      }
    case 'selected':
      if (state.phase !== 'following') return { state, effects: [] }
      return {
        state: { phase: 'following', selected: event.id, entry: 'push' },
        effects: [
          ...(event.id === state.selected || event.id === undefined
            ? []
            : [{ type: 'url' as const, id: event.id, replace: state.entry === 'replace' }]),
          { type: 'show', id: event.id },
        ],
      }
    case 'redirect':
      return state.phase === 'starting'
        ? { state, effects: [] }
        : { state: { ...state, entry: 'replace' }, effects: [] }
    case 'shown':
      return state.phase === 'starting'
        ? { state, effects: [] }
        : {
            state: { ...state, entry: 'push' },
            effects: [{ type: 'url', id: event.id, replace: true }],
          }
    default:
      return event satisfies never
  }
}
