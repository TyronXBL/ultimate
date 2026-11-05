/** The state of an automation's prompt runs. Browser-safe: `runStep` is the only writer of `automation.runs`. */
import type { ConversationId } from '@earendil-works/pi-durable'

/** A run is going, was skipped because another was, or ended; each state holds only the fields it has. */
export type Run =
  | { status: 'running'; id: string; firedAt: number; conversationId?: ConversationId }
  | { status: 'skipped'; id: string; firedAt: number }
  | {
      status: 'done' | 'failed' | 'aborted'
      id: string
      firedAt: number
      conversationId?: ConversationId
      finishedAt: number
      answer?: string
    }

export type RunEvent =
  | { type: 'start'; id: string; firedAt: number }
  /** A fire that found a run still going. */
  | { type: 'skip'; firedAt: number }
  | { type: 'attach'; id: string; conversationId: ConversationId }
  | {
      type: 'finish'
      id: string
      status: 'done' | 'failed' | 'aborted'
      finishedAt: number
      answer?: string
    }

/** How many runs an automation keeps. */
const KEPT = 50

/** The runs over the cap leave oldest first, but a going run never does: it keeps its abort handle and its answer. */
function trim(runs: Run[]): Run[] {
  let excess = runs.length - KEPT
  return runs.filter((run) => {
    if (excess <= 0 || run.status === 'running') return true
    excess--
    return false
  })
}

/** Whether a run is going: a new fire skips while one is, and only a going run can be aborted. */
export const isRunning = (run: Run | undefined) => run?.status === 'running'
export const hasRunningRun = (runs: Run[]) => runs.some(isRunning)

/** The conversation a run works in; a skipped run has none. */
export const runConversation = (run: Run) =>
  run.status === 'skipped' ? undefined : run.conversationId

/** When a run last changed: its end, or its fire while it is going or was skipped. */
export const runEndedAt = (run: Run) =>
  run.status === 'running' || run.status === 'skipped' ? run.firedAt : run.finishedAt

/** The runs after an event. Attaching to or finishing a run that is not going changes nothing. */
export function runStep(runs: Run[], event: RunEvent): Run[] {
  switch (event.type) {
    case 'start':
      return trim([...runs, { status: 'running', id: event.id, firedAt: event.firedAt }])
    case 'skip':
      return trim([
        ...runs,
        { status: 'skipped', id: `skipped:${event.firedAt}`, firedAt: event.firedAt },
      ])
    case 'attach':
      return runs.map((run) =>
        run.id === event.id && run.status === 'running'
          ? { ...run, conversationId: event.conversationId }
          : run,
      )
    case 'finish':
      return runs.map((run): Run => {
        if (run.id !== event.id || run.status !== 'running') return run
        return {
          ...run,
          status: event.status,
          finishedAt: event.finishedAt,
          // The first line of the answer, cut to what a row shows.
          ...(event.answer !== undefined && {
            answer: event.answer.trim().split('\n')[0].slice(0, 200),
          }),
        }
      })
    default:
      return event satisfies never
  }
}
