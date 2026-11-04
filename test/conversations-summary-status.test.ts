import type { TaskId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { summaryStatuses, summaryStep } from '../extensions/conversations/summary-status.ts'
import type { SummaryEvent, SummaryTrack } from '../extensions/conversations/summary-status.ts'

const a = 1 as TaskId
const b = 2 as TaskId

const rows: [name: string, from: SummaryTrack, event: SummaryEvent, to: SummaryTrack][] = [
  [
    'a refresh request owns the summary',
    { status: 'ready' },
    { type: 'requested', task: a },
    { pending: a, status: 'pending' },
  ],
  [
    'a reply that also summarises takes both statuses',
    { pending: a, status: 'pending' },
    { type: 'observed', task: b, summary: true },
    { pending: b, status: 'pending', assessmentStatus: 'pending' },
  ],
  [
    // c8183159: an assessment-only reply displaced a pending spawn refresh and left it "Updating" forever.
    'an assessment-only reply turns a pending summary stale',
    { pending: a, status: 'pending' },
    { type: 'observed', task: b, summary: false },
    { pending: b, status: 'stale', assessmentStatus: 'pending' },
  ],
  [
    'an assessment-only reply leaves a settled summary alone',
    { status: 'ready' },
    { type: 'observed', task: b, summary: false },
    { pending: b, status: 'ready', assessmentStatus: 'pending' },
  ],
  [
    'releasing clears pending marks and keeps settled statuses',
    { pending: a, status: 'pending', assessmentStatus: 'ready' },
    { type: 'released', task: a },
    { assessmentStatus: 'ready' },
  ],
  [
    'a superseded task cannot release',
    { pending: b, status: 'pending' },
    { type: 'released', task: a },
    { pending: b, status: 'pending' },
  ],
  [
    'a summary settles ready',
    { pending: a, status: 'pending', assessmentStatus: 'pending' },
    { type: 'settled', task: a, outcome: 'ready', assessment: true, summary: true },
    { status: 'ready', assessmentStatus: 'ready' },
  ],
  [
    // 7f2bebc8: a result that newer work superseded is stale, not ready.
    'a stale result settles stale',
    { pending: a, status: 'pending', assessmentStatus: 'pending' },
    { type: 'settled', task: a, outcome: 'stale', assessment: true, summary: true },
    { status: 'stale', assessmentStatus: 'stale' },
  ],
  [
    'a refresh settles the summary only',
    { pending: a, status: 'pending', assessmentStatus: 'ready' },
    { type: 'settled', task: a, outcome: 'ready', assessment: false, summary: true },
    { status: 'ready', assessmentStatus: 'ready' },
  ],
  [
    'an assessment-only reply settles the assessment only',
    { pending: a, status: 'ready', assessmentStatus: 'pending' },
    { type: 'settled', task: a, outcome: 'ready', assessment: true, summary: false },
    { status: 'ready', assessmentStatus: 'ready' },
  ],
  [
    'a superseded task cannot settle',
    { pending: b, status: 'pending', assessmentStatus: 'pending' },
    { type: 'settled', task: a, outcome: 'ready', assessment: true, summary: true },
    { pending: b, status: 'pending', assessmentStatus: 'pending' },
  ],
  [
    'abort errors the reply assessment and a pending summary',
    { pending: a, status: 'pending', assessmentStatus: 'pending' },
    { type: 'aborted', task: a, assessment: true },
    { status: 'error', assessmentStatus: 'error' },
  ],
  [
    'abort of a refresh leaves the assessment alone',
    { pending: a, status: 'pending', assessmentStatus: 'ready' },
    { type: 'aborted', task: a, assessment: false },
    { status: 'error', assessmentStatus: 'ready' },
  ],
  [
    'abort of a superseded task writes nothing',
    { pending: b, status: 'pending', assessmentStatus: 'pending' },
    { type: 'aborted', task: a, assessment: true },
    { pending: b, status: 'pending', assessmentStatus: 'pending' },
  ],
]

it.each(rows)('summary status: %s', (_name, from, event, to) => {
  expect(summaryStep(from, event)).toEqual(to)
})

it('the overview shows only the statuses that are set', () => {
  expect(summaryStatuses({ pending: a })).toEqual({})
  expect(summaryStatuses({ status: 'stale', assessmentStatus: 'ready' })).toEqual({
    summaryStatus: 'stale',
    assessmentStatus: 'ready',
  })
})
