/**
 * Where a conversation's summary and reply assessment stand while a summary task owns them: the one transition every
 * writer in `summary.ts` goes through, and the one reading the overview uses. Pure; the fields live in `Summaries`.
 */
import type { TaskId } from '@earendil-works/pi-durable'
import type { SummaryStatus } from './types.ts'

/** `pending` names the task whose result may still settle `status` (the summary) and `assessmentStatus` (the reply's). */
export type SummaryTrack = {
  pending?: TaskId
  status?: SummaryStatus
  assessmentStatus?: SummaryStatus
}

/**
 * `requested`: a spawn, steer or intent refresh was scheduled. `observed`: a reply's task took over; `summary` when it
 * also refreshes the summary. `released`: the task ended without asking (no model, summaries off). `settled`: its
 * result arrived; `assessment` when it is a reply's, `summary` when it carried the summary. `aborted`: it was cancelled.
 * Only the owning task (`pending`) releases, settles or aborts.
 */
export type SummaryEvent =
  | { type: 'requested'; task: TaskId }
  | { type: 'observed'; task: TaskId; summary: boolean }
  | { type: 'released'; task: TaskId }
  | {
      type: 'settled'
      task: TaskId
      outcome: Exclude<SummaryStatus, 'pending'>
      assessment: boolean
      summary: boolean
    }
  | { type: 'aborted'; task: TaskId; assessment: boolean }

const withoutPending = (track: SummaryTrack): SummaryTrack => {
  const { pending: _, ...rest } = track
  return rest
}

/** The statuses without their pending marks: a task that never asked leaves nothing to wait for. */
const cleared = (track: SummaryTrack): SummaryTrack => {
  const { status, assessmentStatus, ...rest } = withoutPending(track)
  return {
    ...rest,
    ...(status && status !== 'pending' ? { status } : {}),
    ...(assessmentStatus && assessmentStatus !== 'pending' ? { assessmentStatus } : {}),
  }
}

export function summaryStep(track: SummaryTrack, event: SummaryEvent): SummaryTrack {
  switch (event.type) {
    case 'requested':
      return { ...track, pending: event.task, status: 'pending' }
    case 'observed':
      return {
        ...track,
        pending: event.task,
        assessmentStatus: 'pending',
        // An assessment-only task supersedes a pending refresh but cannot settle its status later.
        ...(event.summary
          ? { status: 'pending' }
          : track.status === 'pending'
            ? { status: 'stale' }
            : {}),
      }
    case 'released':
      return track.pending === event.task ? cleared(track) : track
    case 'settled':
      return track.pending === event.task
        ? {
            ...withoutPending(track),
            ...(event.assessment ? { assessmentStatus: event.outcome } : {}),
            ...(event.summary ? { status: event.outcome } : {}),
          }
        : track
    default:
      return track.pending === event.task
        ? {
            ...withoutPending(track),
            ...(event.assessment ? { assessmentStatus: 'error' } : {}),
            ...(track.status === 'pending' ? { status: 'error' } : {}),
          }
        : track
  }
}

/** What the overview shows of the track. */
export function summaryStatuses({ status, assessmentStatus }: SummaryTrack) {
  return {
    ...(status ? { summaryStatus: status } : {}),
    ...(assessmentStatus ? { assessmentStatus } : {}),
  }
}
