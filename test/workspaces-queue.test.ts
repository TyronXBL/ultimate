import { expect, it } from 'vitest'
import { advance, newQueueEntry, queueEntryStep } from '../extensions/workspaces/queue.ts'
import type { QueueEvent } from '../extensions/workspaces/queue.ts'
import type { Landed, QueueEntry } from '../extensions/workspaces/types.ts'

const landed = (sha: string): Landed => ({ sha, base: 'b', commits: [], paths: [], flaky: [] })
const queued = newQueueEntry(
  {
    id: 's',
    conversationId: 1,
    source: '/src',
    target: 'main',
    tip: 'abc',
    at: 7,
    divergence: 'None',
  },
  1,
)
const landing = queueEntryStep(queued, { type: 'start', at: 2 })
const working = queueEntryStep(landing, { type: 'step', row: { step: 'checking', at: 3 } })
const fastForwarded = queueEntryStep(working, { type: 'landed', landed: landed('one') })
/** The lander task ended after the fast-forward: the entry returns to queued with its landing. */
const resumed = queueEntryStep(fastForwarded, { type: 'reset' })

// Strict equality: a queued entry must not carry a `step` key, not even an undefined one.
const rows: [string, QueueEntry, QueueEvent, QueueEntry][] = [
  [
    'queued → landing',
    queued,
    { type: 'start', at: 2 },
    { ...queued, state: 'landing', steps: [...queued.steps, { step: 'started', at: 2 }] },
  ],
  [
    'a step shows while landing',
    landing,
    { type: 'step', row: { step: 'checking', at: 3 } },
    {
      ...landing,
      state: 'landing',
      step: 'checking',
      steps: [...landing.steps, { step: 'checking', at: 3 }],
    },
  ],
  [
    'the fast-forward is recorded',
    working,
    { type: 'landed', landed: landed('one') },
    { ...working, landed: landed('one') },
  ],
  // 1901c1b7: a push retry integrates again but must report the first landing.
  [
    'a second fast-forward is ignored',
    fastForwarded,
    { type: 'landed', landed: landed('two') },
    fastForwarded,
  ],
  ['reset drops the current step', working, { type: 'reset' }, { ...queued, steps: working.steps }],
  ['reset of a queued entry changes nothing', queued, { type: 'reset' }, queued],
  // 1901c1b7: the task that takes the entry over must still find what the earlier task landed.
  [
    'reset keeps the landing',
    fastForwarded,
    { type: 'reset' },
    { ...queued, steps: fastForwarded.steps, landed: landed('one') },
  ],
  [
    'starting an entry a faulted task left landing clears its stale step',
    working,
    { type: 'start', at: 9 },
    { ...landing, steps: [...working.steps, { step: 'started', at: 9 }] },
  ],
  [
    'starting a resumed entry keeps its landing',
    resumed,
    { type: 'start', at: 9 },
    { ...resumed, state: 'landing', steps: [...resumed.steps, { step: 'started', at: 9 }] },
  ],
]

it.each(rows)('queue entry: %s', (_name, entry, event, expected) => {
  expect(queueEntryStep(entry, event)).toStrictEqual(expected)
})

it('advance writes a changed entry, leaves an unchanged one and names a missing id', () => {
  const queue = [queued]
  advance(queue, 's', { type: 'start', at: 2 })
  expect(queue[0]).toMatchObject({ state: 'landing' })
  // The reset finds its entry landing, so it replaces it; a second reset returns the same entry, so nothing is written.
  advance(queue, 's', { type: 'reset' })
  const settled = queue[0]
  advance(queue, 's', { type: 'reset' })
  expect(queue[0]).toBe(settled)
  expect(() => advance(queue, 'gone', { type: 'reset' })).toThrow('No queue entry gone')
})
