import type { RecallState } from './refs.ts'

type RecallEvent =
  /** The input needs no check: it counts as checked. */
  | { type: 'skip'; input: number }
  /** The check of this message begins. */
  | { type: 'start'; message: number }
  /** The run stopped during this message's check. */
  | { type: 'abort'; message: number }
  /** The check of this input ended. */
  | { type: 'finish'; input: number }

/** The only writer of the recall document. */
export function recallStep(state: RecallState, event: RecallEvent) {
  switch (event.type) {
    case 'skip':
      state.last = event.input
      return
    case 'start':
      state.pending = event.message
      return
    case 'abort':
      if (state.pending === event.message) delete state.pending
      return
    case 'finish':
      delete state.pending
      state.last = event.input
      return
    default:
      event satisfies never
  }
}

/** Whether recall is checking this input entry now. */
export const checking = (state: Readonly<RecallState> | null | undefined, entryId: number) =>
  state?.pending === entryId
