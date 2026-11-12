import { describe, expect, test } from 'vitest'
import { queueView } from '../queue.ts'
import type { QueueFacts, Turn } from '../queue.ts'

const claim = (n: number, label: string) => ({
  id: `my-app:background:${n}`,
  at: 1000 + n,
  label,
  from: `#${n} in my-app`,
})
const facts: QueueFacts = { usage: new Map() }
const reasons = (turn: Turn, more: Partial<QueueFacts> = {}) =>
  queueView(turn, { ...facts, ...more }).map((job) =>
    job.state === 'waiting' ? [job.position, job.reason] : [job.state, job.label],
  )

describe('queueView', () => {
  test('a waiter waits behind the job just ahead of it, the first behind the job that runs', () => {
    const turn: Turn = {
      kind: 'behind',
      running: { ...claim(1, 'pnpm test'), state: 'running', since: 2000, holder: { pid: 41 } },
      ahead: [claim(2, 'pnpm check'), claim(3, 'pnpm fix')],
    }
    expect(reasons(turn)).toEqual([
      ['running', 'pnpm test'],
      [1, { kind: 'behind', label: 'pnpm test', from: '#1 in my-app' }],
      [2, { kind: 'behind', label: 'pnpm check', from: '#2 in my-app' }],
    ])
    expect(queueView(turn, facts)[0]).toMatchObject({ project: 'my-app', conversation: 1 })
  })

  test('the first waiter with nothing running waits for the queue to settle, then RAM, else starts at its next look', () => {
    // The end-of-line turn says `behind` while anyone waits, so it never tells a settling queue (review of #231847).
    const turn: Turn = { kind: 'behind', ahead: [claim(2, 'pnpm test')] }
    const short = { available: 3500, need: 1536, floor: 3072 }
    expect(reasons(turn, { settling: 40_000, short })).toEqual([
      [1, { kind: 'settling', until: 40_000 }],
    ])
    expect(reasons(turn, { short })).toEqual([
      [1, { kind: 'ram', availableMiB: 3500, needMiB: 1536, floorMiB: 3072 }],
    ])
    expect(reasons(turn)).toEqual([[1, { kind: 'next' }]])
  })

  test('reads the holders of #227574’s queue: a job measured on probation holds the slot too', () => {
    const turn: Turn = {
      kind: 'behind',
      holders: [
        { ...claim(1, 'pnpm test'), state: 'running', since: 2000, holder: { pid: 41 } },
        {
          ...claim(4, 'bash slice.sh'),
          state: 'measuring',
          since: 9000,
          until: 29_000,
          holder: { pid: 42 },
        },
      ],
      ahead: [claim(2, 'pnpm check')],
    }
    const usage = new Map([[claim(4, '').id, { cpu: 3.2, rssMiB: 900 }]])
    expect(queueView(turn, { ...facts, usage }).slice(1)).toEqual([
      {
        ...claim(4, 'bash slice.sh'),
        project: 'my-app',
        conversation: 4,
        state: 'measuring',
        since: 9000,
        until: 29_000,
        cpu: 3.2,
        rssMiB: 900,
      },
      {
        ...claim(2, 'pnpm check'),
        project: 'my-app',
        conversation: 2,
        state: 'waiting',
        position: 1,
        reason: { kind: 'behind', label: 'bash slice.sh', from: '#4 in my-app' },
      },
    ])
  })
})
