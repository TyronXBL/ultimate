import { describe, expect, test } from 'vitest'
import type { SlotEntry, SlotQueue } from '../../../lib/slot.ts'
import { queueView } from '../queue.ts'
import type { QueueFacts } from '../queue.ts'

const claim = (n: number, label: string, kind: 'heavy' | 'unknown' = 'heavy') => ({
  id: `my-app:background:${n}`,
  kind,
  at: 1000 + n,
  label,
  from: `#${n} in my-app`,
})
const holder = { pid: 40, identity: 'boot:1' }
const running = (n: number, label: string, kind: 'heavy' | 'unknown' = 'heavy'): SlotEntry => ({
  ...claim(n, label, kind),
  state: 'running',
  since: 2000,
  holder,
})
const waiting = (n: number, label: string): SlotEntry => ({
  ...claim(n, label),
  state: 'waiting',
  seen: 9000,
})
const facts: QueueFacts = { now: 10_000, places: 2, usage: new Map() }
const reasons = (queue: SlotQueue, more: Partial<QueueFacts> = {}) =>
  queueView(queue, { ...facts, ...more }).map((job) =>
    job.state === 'waiting' ? [job.position, job.reason] : [job.state, job.label],
  )

describe('queueView', () => {
  test('waiters in the order they asked: the first waits for a place, the rest behind the one ahead', () => {
    // Written out of order on purpose: the file keeps entries in the order they changed, not the line's.
    const queue: SlotQueue = {
      entries: [
        waiting(3, 'pnpm fix'),
        running(1, 'pnpm test'),
        waiting(2, 'pnpm check'),
        running(4, 'bash slice.sh', 'unknown'),
      ],
    }
    expect(reasons(queue)).toEqual([
      ['running', 'pnpm test'],
      ['running', 'bash slice.sh'],
      [1, { kind: 'full', running: 2, places: 2 }],
      [2, { kind: 'behind', label: 'pnpm check', from: '#2 in my-app' }],
    ])
    expect(queueView(queue, facts)[1]).toMatchObject({ observed: true, conversation: 4 })
  })

  test('with a place free, the first waiter waits for the queue to settle, for CPU, for memory, else starts', () => {
    const queue: SlotQueue = { entries: [running(1, 'pnpm test'), waiting(2, 'pnpm check')] }
    const gate = {
      kind: 'wait' as const,
      load: 7.2,
      cores: 6,
      pressure: 31,
      below: { load: 6, pressure: 20 },
      settling: false,
    }
    const cap = { kind: 'cap' as const, used: 5400, high: 5632, need: 1024 }
    const first = (more: Partial<QueueFacts>, settleUntil?: number) =>
      reasons({ ...queue, ...(settleUntil && { settleUntil }) }, more)[1]
    expect(first({ gate, short: cap }, 40_000)).toEqual([1, { kind: 'settling', until: 40_000 }])
    expect(first({ gate, short: cap })).toEqual([
      1,
      { kind: 'cpu', load: 7.2, cores: 6, pressure: 31, belowLoad: 6, belowPressure: 20 },
    ])
    expect(first({ short: cap })).toEqual([
      1,
      { kind: 'cap', usedMiB: 5400, highMiB: 5632, needMiB: 1024 },
    ])
    expect(first({ gate: { kind: 'go' } })).toEqual([1, { kind: 'next' }])
  })

  test('a job on probation holds a place until it is measured, with its live usage', () => {
    const queue: SlotQueue = {
      entries: [
        {
          ...claim(4, 'bash slice.sh', 'unknown'),
          state: 'measuring',
          since: 9000,
          until: 29_000,
          holder,
        },
      ],
    }
    const usage = new Map([[claim(4, '').id, { cpu: 3.2, rssMiB: 900 }]])
    expect(queueView(queue, { ...facts, usage })).toEqual([
      {
        id: claim(4, '').id,
        label: 'bash slice.sh',
        from: '#4 in my-app',
        project: 'my-app',
        conversation: 4,
        at: 1004,
        state: 'measuring',
        since: 9000,
        until: 29_000,
        cpu: 3.2,
        rssMiB: 900,
      },
    ])
  })
})
