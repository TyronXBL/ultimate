import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import {
  enterSlot,
  holdSlot,
  releaseSlot,
  SETTLE_MS,
  slotStep,
  slotTurn,
  thisProcess,
  WAIT_TTL_MS,
} from '../lib/slot.ts'
import type { SlotClaim, SlotEntry, SlotEvent, SlotQueue } from '../lib/slot.ts'
import { stateDir } from '../lib/memory.ts'
import { temp } from './helpers.ts'

afterEach(() => {
  vi.useRealTimers()
})

const claim = (id: string, at = 100): SlotClaim => ({
  id,
  at,
  label: `job ${id}`,
  from: '#1 in my-app',
})
const holder = { pid: 42, identity: 'boot:7' }
const waiting = (id: string, at = 100, seen = 1000): SlotEntry => ({
  ...claim(id, at),
  state: 'waiting',
  seen,
})
const running = (id: string, at = 100, since = 1000): SlotEntry => ({
  ...claim(id, at),
  state: 'running',
  since,
  holder,
})
const queue = (...entries: SlotEntry[]): SlotQueue => ({ entries })
const alive = (pid: number) => (h: { pid: number }) => h.pid === pid

it.each<[string, SlotQueue, SlotEvent, SlotQueue]>([
  [
    'a wait joins the line',
    queue(),
    { type: 'wait', claim: claim('a'), now: 1000 },
    queue(waiting('a')),
  ],
  [
    'a wait again refreshes when it was seen',
    queue(waiting('a')),
    { type: 'wait', claim: claim('a'), now: 2000 },
    queue(waiting('a', 100, 2000)),
  ],
  [
    'a late wait never takes the slot back',
    queue(running('a')),
    { type: 'wait', claim: claim('a'), now: 2000 },
    queue(running('a')),
  ],
  [
    'a start takes the slot from the line',
    queue(waiting('a')),
    { type: 'start', claim: claim('a'), holder, now: 2000 },
    queue(running('a', 100, 2000)),
  ],
  [
    'a start of a job not in line (a removed file) takes the slot',
    queue(),
    { type: 'start', claim: claim('a'), holder, now: 2000 },
    queue(running('a', 100, 2000)),
  ],
  [
    'a start again keeps when it started',
    queue(running('a')),
    { type: 'start', claim: claim('a'), holder, now: 3000 },
    queue(running('a')),
  ],
  [
    'a release leaves the line',
    queue(running('a'), waiting('b')),
    { type: 'release', id: 'a' },
    queue(waiting('b')),
  ],
  [
    'a release of a job not in line changes nothing',
    queue(waiting('b')),
    { type: 'release', id: 'a' },
    queue(waiting('b')),
  ],
  [
    'expiry drops a waiter that stopped looking',
    queue(waiting('a', 100, 1000), waiting('b', 100, 1001)),
    { type: 'expire', now: 1001 + WAIT_TTL_MS, alive: alive(42) },
    queue(waiting('b', 100, 1001)),
  ],
  [
    'expiry drops a job whose holder is gone',
    queue(running('a'), waiting('b')),
    { type: 'expire', now: 1000, alive: alive(7) },
    queue(waiting('b')),
  ],
  [
    'expiry ends a settling time that passed',
    { entries: [], settleUntil: 1000 },
    { type: 'expire', now: 1000, alive: alive(42) },
    queue(),
  ],
  [
    'expiry keeps a settling time still ahead',
    { entries: [], settleUntil: 1001 },
    { type: 'expire', now: 1000, alive: alive(42) },
    { entries: [], settleUntil: 1001 },
  ],
])('%s', (_name, before, event, after) => {
  expect(slotStep(before, event)).toEqual(after)
})

it.each<[string, SlotQueue, SlotClaim, ReturnType<typeof slotTurn>]>([
  ['nothing runs and nobody waits: its turn', queue(), claim('a'), { kind: 'next' }],
  [
    'it holds the slot already: still its turn',
    queue(running('a'), waiting('b', 50)),
    claim('a'),
    { kind: 'next' },
  ],
  [
    'another job runs',
    queue(running('b')),
    claim('a'),
    { kind: 'behind', running: running('b'), ahead: [] },
  ],
  [
    'an earlier job waits',
    queue(waiting('b', 50), waiting('a')),
    claim('a'),
    { kind: 'behind', ahead: [claim('b', 50)] },
  ],
  [
    'the same time: the smaller id first',
    queue(waiting('a')),
    claim('b'),
    { kind: 'behind', ahead: [claim('a')] },
  ],
  ['only later jobs wait', queue(waiting('b', 200), waiting('a')), claim('a'), { kind: 'next' }],
  [
    'the file was just removed',
    { entries: [], settleUntil: 2000 },
    claim('a'),
    { kind: 'settling', until: 2000 },
  ],
])('turn: %s', (_name, line, asking, turn) => {
  expect(slotTurn(line, asking, 1000)).toEqual(turn)
})

const enter = (parent: string, asking: SlotClaim, queued = true) =>
  enterSlot(asking, { floor: undefined, need: 1024, start: thisProcess, parent, queue: queued })

it('grants the slot one job at a time, in the order the jobs asked', async () => {
  const parent = await temp('ultimate-slot-')
  expect(await enter(parent, claim('first', 100))).toMatchObject({ kind: 'started' })
  expect(await enter(parent, claim('third', 300))).toMatchObject({
    kind: 'waiting',
    turn: { kind: 'behind' },
  })
  expect(await enter(parent, claim('second', 200))).toMatchObject({
    kind: 'waiting',
    turn: { ahead: [] },
  })
  await releaseSlot('first', parent)
  // `third` looks first, but `second` asked earlier.
  expect(await enter(parent, claim('third', 300))).toMatchObject({
    kind: 'waiting',
    turn: { ahead: [claim('second', 200)] },
  })
  // A plain bash command neither starts beside a waiter nor joins the line.
  expect(await enter(parent, claim('bash', 400), false)).toMatchObject({ kind: 'waiting' })
  expect(await enter(parent, claim('second', 200))).toMatchObject({ kind: 'started' })
  expect(await enter(parent, claim('bash', 400), false)).toMatchObject({
    kind: 'waiting',
    turn: { running: { id: 'second' } },
  })
  await releaseSlot('second', parent)
  expect(await enter(parent, claim('third', 300))).toMatchObject({ kind: 'started' })
  await releaseSlot('third', parent)
  expect(await enter(parent, claim('bash', 400), false)).toMatchObject({ kind: 'started' })
})

it('starts nobody beside a running job after its file was removed, and keeps the order', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const parent = await temp('ultimate-slot-')
  expect(await enter(parent, claim('running', 100))).toMatchObject({ kind: 'started' })
  expect(await enter(parent, claim('waiting', 200))).toMatchObject({ kind: 'waiting' })
  // The daily temp cleanup, or a hand, removes the whole folder.
  await rm(await stateDir(parent), { recursive: true })
  expect(await enter(parent, claim('waiting', 200))).toMatchObject({
    kind: 'waiting',
    turn: { kind: 'settling' },
  })
  // The running job says so again at its next look, within the settling time.
  await holdSlot(claim('running', 100), thisProcess(), parent)
  vi.setSystemTime(Date.now() + SETTLE_MS)
  expect(await enter(parent, claim('waiting', 200))).toMatchObject({
    kind: 'waiting',
    turn: { running: { id: 'running' } },
  })
  await releaseSlot('running', parent)
  expect(await enter(parent, claim('waiting', 200))).toMatchObject({ kind: 'started' })
})
