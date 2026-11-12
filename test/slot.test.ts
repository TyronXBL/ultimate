import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { PRESSURE_WAIT_MS, PROBATION_MS } from '../lib/cpu.ts'
import {
  enterSlot,
  heavySlot,
  holdSlot,
  readSlot,
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

/** The machine's load as the queue reads it: idle unless a test says otherwise. */
const machine = vi.hoisted(() => ({ load: { load: 0, cores: 6, pressure: 0 } }))
vi.mock('../lib/cpu.ts', async (original) => ({
  ...(await original<typeof import('../lib/cpu.ts')>()),
  machineLoad: async () => machine.load,
}))

afterEach(() => {
  vi.useRealTimers()
  machine.load = { load: 0, cores: 6, pressure: 0 }
})

const claim = (id: string, at = 100, kind: SlotClaim['kind'] = 'heavy'): SlotClaim => ({
  id,
  kind,
  at,
  label: `job ${id}`,
  from: '#1 in my-app',
})
const unknown = (id: string, at = 100) => claim(id, at, 'unknown')
const holder = { pid: 42, identity: 'boot:7' }
const waiting = (id: string, at = 100, seen = 1000): SlotEntry => ({
  ...claim(id, at),
  state: 'waiting',
  seen,
})
const running = (id: string, at = 100, since = 1000): Extract<SlotEntry, { state: 'running' }> => ({
  ...claim(id, at),
  state: 'running',
  since,
  holder,
})
const measured = (
  id: string,
  at = 100,
  since = 1000,
): Extract<SlotEntry, { state: 'measuring' }> => ({
  ...unknown(id, at),
  state: 'measuring',
  since,
  until: since + PROBATION_MS,
  holder,
})
const waitingUnknown = (id: string, at = 100, seen = 1000): SlotEntry => ({
  ...unknown(id, at),
  state: 'waiting',
  seen,
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
    'an unknown job that starts is measured',
    queue(waitingUnknown('a')),
    { type: 'start', claim: unknown('a'), holder, now: 1000 },
    queue(measured('a')),
  ],
  [
    'an unknown job said again stays on its probation',
    queue(measured('a')),
    { type: 'start', claim: unknown('a'), holder, now: 5000 },
    queue(measured('a')),
  ],
  [
    'measured heavy, it holds the slot since it started',
    queue(measured('a')),
    { type: 'heavy', claim: unknown('a'), holder, now: 21_000 },
    queue({ ...unknown('a'), state: 'running', since: 1000, holder }),
  ],
  [
    'a light job that turns heavy holds the slot from then on',
    queue(running('b')),
    { type: 'heavy', claim: unknown('a'), holder, now: 9000 },
    queue(running('b'), { ...unknown('a'), state: 'running', since: 9000, holder }),
  ],
  [
    'a late wait never ends a probation',
    queue(measured('a')),
    { type: 'wait', claim: unknown('a'), now: 2000 },
    queue(measured('a')),
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
    'expiry keeps a probation its owner may still decide',
    queue(measured('a')),
    { type: 'expire', now: 1000 + PROBATION_MS + WAIT_TTL_MS, alive: alive(42) },
    queue(measured('a')),
  ],
  [
    'expiry ends a probation its owner stopped deciding',
    queue(measured('a')),
    { type: 'expire', now: 1001 + PROBATION_MS + WAIT_TTL_MS, alive: alive(42) },
    queue(),
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

it.each<[string, SlotQueue, SlotClaim, ReturnType<typeof slotTurn>, number?]>([
  ['nothing runs and nobody waits: its turn', queue(), claim('a'), { kind: 'next' }],
  [
    'two places: a second heavy job starts beside one',
    queue(running('b')),
    claim('a'),
    { kind: 'next' },
    2,
  ],
  [
    'two places: a third waits until one is free',
    queue(running('b'), running('c')),
    claim('a'),
    { kind: 'behind', holders: [running('b'), running('c')], ahead: [], limit: 2 },
    2,
  ],
  [
    'two places: a job on probation takes one',
    queue(running('b'), measured('c')),
    claim('a'),
    { kind: 'behind', holders: [running('b'), measured('c')], ahead: [], limit: 2 },
    2,
  ],
  [
    'two places: the order is kept, an earlier waiter goes first',
    queue(running('b'), waiting('c', 50)),
    claim('a'),
    { kind: 'behind', holders: [running('b')], ahead: [claim('c', 50)], limit: 2 },
    2,
  ],
  [
    'two places, one taken: an unknown job keeps its turn behind a heavy waiter',
    queue(running('b'), waiting('c', 50)),
    unknown('a'),
    { kind: 'behind', holders: [running('b')], ahead: [claim('c', 50)], limit: 2 },
    2,
  ],
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
    { kind: 'behind', holders: [running('b')], ahead: [], limit: 1 },
  ],
  [
    'an earlier job waits',
    queue(waiting('b', 50), waiting('a')),
    claim('a'),
    { kind: 'behind', holders: [], ahead: [claim('b', 50)], limit: 1 },
  ],
  [
    'the same time: the smaller id first',
    queue(waiting('a')),
    claim('b'),
    { kind: 'behind', holders: [], ahead: [claim('a')], limit: 1 },
  ],
  [
    'a heavy job waits for a probation',
    queue(measured('b')),
    claim('a'),
    { kind: 'behind', holders: [measured('b')], ahead: [], limit: 1 },
  ],
  [
    'unknown jobs are measured one at a time (the incident: three wrapper scripts at once)',
    queue(measured('b')),
    unknown('a'),
    { kind: 'behind', holders: [measured('b')], ahead: [], limit: 1 },
  ],
  [
    'an unknown job needs a free place too (the reproduction: three wrapper scripts let in by load ran together)',
    queue(running('b')),
    unknown('a'),
    { kind: 'behind', holders: [running('b')], ahead: [], limit: 1 },
  ],
  [
    'an unknown job keeps its turn behind a heavy waiter when nothing runs',
    queue(waiting('c', 50)),
    unknown('a'),
    { kind: 'behind', holders: [], ahead: [claim('c', 50)], limit: 1 },
  ],
  [
    'unknown jobs keep their order among themselves',
    queue(running('b'), waitingUnknown('c', 50)),
    unknown('a'),
    { kind: 'behind', holders: [running('b')], ahead: [unknown('c', 50)], limit: 1 },
  ],
  ['only later jobs wait', queue(waiting('b', 200), waiting('a')), claim('a'), { kind: 'next' }],
  [
    'the file was just removed',
    { entries: [], settleUntil: 2000 },
    claim('a'),
    { kind: 'settling', until: 2000 },
  ],
])('turn: %s', (_name, line, asking, turn, limit = 1) => {
  expect(slotTurn(line, asking, 1000, limit)).toEqual(turn)
})

const limits = (max = 1, floor?: number) => ({ floor, cpu: undefined, max })
const enter = (parent: string, asking: SlotClaim, queued = true, max = 1, floor?: number) =>
  enterSlot(asking, {
    limits: limits(max, floor),
    need: 1024,
    start: thisProcess,
    parent,
    queue: queued,
  })

it('runs two at a time with two places: the third waits in order, a finished one admits the next', async () => {
  const parent = await temp('ultimate-slot-')
  const two = (asking: SlotClaim, floor?: number) => enter(parent, asking, true, 2, floor)
  expect(await two(claim('first', 100))).toMatchObject({ kind: 'started' })
  // RAM is admitted per job: a second never starts into the floor, however many places are free.
  expect(await two(claim('second', 200), Number.MAX_SAFE_INTEGER)).toMatchObject({ kind: 'ram' })
  expect(await two(claim('second', 200))).toMatchObject({ kind: 'started' })
  expect(await two(claim('fourth', 400))).toMatchObject({ kind: 'waiting' })
  expect(await two(claim('third', 300))).toMatchObject({
    kind: 'waiting',
    turn: { holders: [{ id: 'first' }, { id: 'second' }], ahead: [], limit: 2 },
  })
  // What a reader shows: both running, two waiting, and the machine as admission sees it.
  const shown = await readSlot(parent)
  expect(shown.queue.entries.map(({ id, state }) => `${id} ${state}`).toSorted()).toEqual([
    'first running',
    'fourth waiting',
    'second running',
    'third waiting',
  ])
  expect(shown.load).toEqual(machine.load)
  await releaseSlot('first', parent)
  // `fourth` looks first, but `third` asked earlier.
  expect(await two(claim('fourth', 400))).toMatchObject({
    kind: 'waiting',
    turn: { ahead: [claim('third', 300)] },
  })
  expect(await two(claim('third', 300))).toMatchObject({ kind: 'started' })
  // The limit is read at every look: back at one, nothing starts beside two running jobs.
  await releaseSlot('second', parent)
  expect(await enter(parent, claim('fourth', 400), true, 1)).toMatchObject({ kind: 'waiting' })
  expect(await two(claim('fourth', 400))).toMatchObject({ kind: 'started' })
})

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
    turn: { holders: [{ id: 'second' }] },
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
    turn: { holders: [{ id: 'running' }] },
  })
  await releaseSlot('running', parent)
  expect(await enter(parent, claim('waiting', 200))).toMatchObject({ kind: 'started' })
})

const look = (
  parent: string,
  asking: SlotClaim,
  pressureSince?: number,
): ReturnType<typeof enterSlot> =>
  enterSlot(asking, {
    limits: { floor: undefined, cpu: 1, max: 1 },
    need: 0,
    start: thisProcess,
    parent,
    pressureSince,
  })

it('takes turns with jobs it does not know: one measured at a time, a heavy one holding the slot', async () => {
  const parent = await temp('ultimate-slot-')
  // Three wrapper scripts asked at the same moment, from two worktrees.
  expect(await look(parent, unknown('first', 100))).toMatchObject({ kind: 'started' })
  expect(await look(parent, unknown('second', 101))).toMatchObject({
    kind: 'waiting',
    turn: { holders: [{ id: 'first', state: 'measuring' }] },
  })
  expect(await look(parent, unknown('third', 102))).toMatchObject({ kind: 'waiting' })
  // Measured above a core: it keeps its place, however little load it shows.
  await heavySlot(unknown('first', 100), thisProcess(), parent)
  expect(await look(parent, unknown('second', 101))).toMatchObject({
    kind: 'waiting',
    turn: { holders: [{ id: 'first', state: 'running' }] },
  })
  // Ended: the load it left behind still holds the next one back, until it falls.
  await releaseSlot('first', parent)
  machine.load = { load: 6.5, cores: 6, pressure: 0 }
  expect(await look(parent, unknown('second', 101))).toMatchObject({
    kind: 'cpu',
    gate: { kind: 'wait', load: 6.5, cores: 6, pressure: 0 },
  })
  machine.load = { load: 1, cores: 6, pressure: 0 }
  expect(await look(parent, unknown('second', 101))).toMatchObject({ kind: 'started' })
  // Measured light: it leaves the queue, and the third one's turn comes.
  await releaseSlot('second', parent)
  expect(await look(parent, unknown('third', 102))).toMatchObject({ kind: 'started' })
})

it('waits for load it does not cause, then starts anyway and says so', async () => {
  const parent = await temp('ultimate-slot-')
  machine.load = { load: 9, cores: 6, pressure: 0 }
  expect(await look(parent, claim('heavy'))).toMatchObject({ kind: 'cpu', outside: true })
  expect(await look(parent, claim('heavy'), Date.now() - PRESSURE_WAIT_MS + 60_000)).toMatchObject({
    kind: 'cpu',
  })
  expect(await look(parent, claim('heavy'), Date.now() - PRESSURE_WAIT_MS)).toMatchObject({
    kind: 'started',
    forced: { kind: 'forced', load: 9, cores: 6, pressure: 0 },
  })
})
