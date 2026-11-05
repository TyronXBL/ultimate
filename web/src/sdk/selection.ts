export type Selection =
  | { phase: 'starting' }
  | { phase: 'following'; selected: number | undefined; entry: 'push' | 'replace' }

type Event =
  | { type: 'started'; id: number | undefined }
  | { type: 'selected'; id: number | undefined }
  | { type: 'redirect' }
  | { type: 'shown'; id: number }

type Effect =
  | { type: 'url'; id: number; replace: boolean }
  | { type: 'show'; id: number | undefined }

/** The only writer of selection state. */
export function step(state: Selection, event: Event): { state: Selection; effects: Effect[] } {
  switch (event.type) {
    case 'started':
      if (state.phase !== 'starting') return { state, effects: [] }
      return {
        state: { phase: 'following', selected: event.id, entry: 'replace' },
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
