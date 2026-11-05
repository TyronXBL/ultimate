import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import { createUiState, step } from '../../web/src/sdk/ui-state.ts'
import type { SyncEvent, SyncState, Write } from '../../web/src/sdk/ui-state.ts'
import { UI_REVISION } from '../../shared/protocol.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../shared/protocol.ts'

/**
 * A tab against a fake server that counts `ui.rev` as `POST /api/ui` does. A request is committed (`commit(i)`,
 * returning the snapshot the stream would deliver) and acknowledged (`ack(i)`) separately, so tests choose the order
 * in which the stream and the HTTP answer arrive.
 */
function setup() {
  let doc: Record<string, JsonValue> = {}
  const revs: number[] = []
  const requests: {
    change: UiUpdateRequest
    ack: () => void
    fail: (error: unknown) => void
  }[] = []
  const errors: unknown[] = []
  const state = createUiState(
    (change) =>
      new Promise<UiUpdateResponse>((resolve, reject) => {
        const index = requests.length
        requests.push({
          change,
          ack: () => resolve({ ok: true, rev: revs[index] }),
          fail: reject,
        })
      }),
    { delayMs: 5, onError: (error) => errors.push(error) },
  )
  const apply = (set: Record<string, JsonValue> = {}, remove: readonly string[] = []) => {
    const rev = (typeof doc[UI_REVISION] === 'number' ? doc[UI_REVISION] : 0) + 1
    doc = { ...doc, ...set, [UI_REVISION]: rev }
    for (const key of remove) delete doc[key]
    return { ...doc }
  }
  return {
    state,
    requests,
    errors,
    commit: (index: number) => {
      const snapshot = apply(requests[index].change.set, requests[index].change.delete ?? [])
      revs[index] = snapshot[UI_REVISION] as number
      return snapshot
    },
    ack: (index: number) => requests[index].ack(),
    /** Another tab's or device's commit. */
    other: (set: Record<string, JsonValue>) => apply(set),
    start: (set: Record<string, JsonValue>) => state.receive(apply(set)),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const wait = (ms = 20) => vi.advanceTimersByTimeAsync(ms)

describe('durable UI state', () => {
  it('applies writes at once, sends them coalesced, and keeps them until the stream shows them', async () => {
    const { state, requests, commit, ack, other, start } = setup()
    const listener = vi.fn<() => void>()
    state.subscribe(listener)
    start({ 'shell.panelOpen': false, 'shell.surface': 'example' })

    state.set('shell.panelOpen', true)
    state.set('shell.panel', 'info')
    state.delete('shell.surface')
    expect(state.get('shell.panelOpen')).toBe(true)
    expect(state.get('shell.surface')).toBeUndefined()
    expect(listener).toHaveBeenCalled()

    await wait()
    expect(requests.map((request) => request.change)).toEqual([
      { set: { 'shell.panelOpen': true, 'shell.panel': 'info' }, delete: ['shell.surface'] },
    ])
    const committed = commit(0)
    ack(0)
    await wait()
    expect(state.get('shell.panelOpen')).toBe(true)
    state.receive(committed)
    // Confirmed: a later change from another tab shows through at once.
    state.receive(other({ 'shell.panelOpen': false }))
    expect(state.get('shell.panelOpen')).toBe(false)
    expect(state.get('shell.panel')).toBe('info')
  })

  it('sends one batch at a time, so the server commits writes in order', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'first')
    await wait()
    state.set('panel', 'second')
    state.set('panel', 'third')
    await wait()
    expect(requests).toHaveLength(1)
    commit(0)
    ack(0)
    await wait()
    expect(requests.map((request) => request.change.set)).toEqual([
      { panel: 'first' },
      { panel: 'third' },
    ])
  })

  it('keeps the newest write when a reconnect delivers a snapshot from between two writes', async () => {
    // System, then Agent, both answered; the stream reconnects and lags far behind both.
    const { state, commit, ack, start } = setup()
    start({ 'shell.surface': 'agent' })
    state.set('shell.surface', 'system')
    await wait()
    const between = commit(0)
    ack(0)
    await wait()
    state.set('shell.surface', 'agent')
    await wait()
    const latest = commit(1)
    ack(1)
    await wait(5000)
    expect(state.get('shell.surface')).toBe('agent')
    state.receive(between)
    expect(state.get('shell.surface')).toBe('agent')
    state.receive(latest)
    expect(state.get('shell.surface')).toBe('agent')
  })

  it('drops a snapshot older than one already shown', async () => {
    const { state, other, start } = setup()
    start({ panel: 'start' })
    const older = other({ panel: 'older' })
    const newer = other({ panel: 'newer' })
    state.receive(newer)
    state.receive(older)
    expect(state.get('panel')).toBe('newer')
  })

  it('lets another tab’s later write win over this tab’s confirmed one', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    const mine = commit(0)
    ack(0)
    await wait()
    state.receive(mine)
    state.receive(other({ panel: 'theirs' }))
    expect(state.get('panel')).toBe('theirs')
  })

  it('confirms by revision: A → B → A never flashes B', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    // info, tasks, info: each committed and answered, while the stream lags behind all three.
    state.set('panel', 'info')
    await wait()
    const first = commit(0)
    ack(0)
    await wait()
    state.set('panel', 'tasks')
    await wait()
    const second = commit(1)
    ack(1)
    await wait()
    state.set('panel', 'info')
    await wait()
    expect(requests).toHaveLength(3)
    // The first commit equals the newest local value but is not its write.
    state.receive(first)
    expect(state.get('panel')).toBe('info')
    state.receive(second)
    expect(state.get('panel')).toBe('info')
    // The last write's answer comes before its commit streams in.
    const third = commit(2)
    ack(2)
    await wait()
    expect(state.get('panel')).toBe('info')
    state.receive(third)
    expect(state.get('panel')).toBe('info')
  })

  it('keeps its write when another tab wrote the same key just before', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    // Another tab's commit lands before this tab's.
    state.receive(other({ panel: 'theirs' }))
    expect(state.get('panel')).toBe('mine')
    const mine = commit(0)
    ack(0)
    await wait()
    expect(state.get('panel')).toBe('mine')
    state.receive(mine)
    expect(state.get('panel')).toBe('mine')
  })

  it('confirms a write whose commit the stream showed before its answer', async () => {
    const { state, commit, ack, other, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    state.receive(commit(0))
    state.receive(other({ panel: 'theirs' }))
    // Not yet answered: the write still shows.
    expect(state.get('panel')).toBe('mine')
    ack(0)
    await wait()
    expect(state.get('panel')).toBe('theirs')
  })

  it('takes a restarted server’s snapshot whatever its revision', async () => {
    const { state, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'mine')
    await wait()
    state.receive(commit(0))
    ack(0)
    await wait()
    // `pnpm reset` and a restart: the new storage counts from scratch.
    state.restarted()
    state.receive({ panel: 'fresh', [UI_REVISION]: 1 })
    expect(state.get('panel')).toBe('fresh')
  })

  it('keeps an acknowledged write shown across a restart until the new snapshot arrives', async () => {
    const { state, commit, ack, start } = setup()
    start({ 'shell.surface': 'agent' })
    state.set('shell.surface', 'system')
    await wait()
    commit(0)
    ack(0)
    await wait()
    // The old process goes away before the stream showed the write; nothing rolls the surface back meanwhile.
    state.restarted()
    await wait(5000)
    expect(state.get('shell.surface')).toBe('system')
    // The new process's first snapshot is the truth, whatever its revision.
    state.receive({ 'shell.surface': 'system', [UI_REVISION]: 1 })
    state.receive({ 'shell.surface': 'review', [UI_REVISION]: 2 })
    expect(state.get('shell.surface')).toBe('review')
  })

  it('ignores an old server’s late reply and sends unsent edits to the new one', async () => {
    const { state, requests, commit, ack, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'old')
    await wait()
    commit(0)
    state.set('view', 'unsent')
    // The old process goes away while its answer is still on the way.
    state.restarted()
    expect(state.get('panel')).toBe('old')
    expect(state.get('view')).toBe('unsent')
    await wait()
    expect(requests[1].change.set).toEqual({ view: 'unsent' })
    ack(0)
    await wait()
    state.receive({ panel: 'fresh', [UI_REVISION]: 1 })
    state.receive({ panel: 'other device', [UI_REVISION]: 2 })
    expect(state.get('panel')).toBe('other device')
    expect(state.get('view')).toBe('unsent')
  })

  it('skips no-op writes, drops refused writes, and keeps a newer write when an older batch fails', async () => {
    const refused = setup()
    refused.start({ panel: 'start' })
    refused.state.set('panel', 'start')
    await wait()
    expect(refused.requests).toHaveLength(0)
    refused.state.set('bad key', 1)
    expect(refused.state.get('bad key')).toBe(1)
    await wait()
    refused.requests[0].fail(new Error('Invalid UI key'))
    await wait()
    expect(refused.state.get('bad key')).toBeUndefined()
    expect(refused.errors).toHaveLength(1)

    const { state, requests, errors, start } = setup()
    start({ panel: 'start' })
    state.set('panel', 'first')
    state.set('view', 'example')
    await wait()
    state.set('panel', 'second')
    requests[0].fail(new Error('offline'))
    await wait()
    expect(errors).toHaveLength(1)
    // The failed batch's own key reverts; the key written again keeps its newer value and is sent next.
    expect(state.get('view')).toBeUndefined()
    expect(state.get('panel')).toBe('second')
    expect(requests[1].change.set).toEqual({ panel: 'second' })
  })

  it('keeps a detached page’s writes to itself: applied, kept, never sent', async () => {
    // A page an agent drives: its `?conversation=1` must not move the user's tabs.
    const state = createUiState(undefined, { delayMs: 5 })
    state.receive({ 'shell.conversation': 42, 'shell.panel': 'info', [UI_REVISION]: 7 })
    state.set('shell.conversation', 1)
    state.delete('shell.panel')
    await wait()
    state.flush()
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panel')).toBeUndefined()
    // A later snapshot leaves the page's own writes in place.
    state.receive({ 'shell.conversation': 43, 'shell.panel': 'info', [UI_REVISION]: 8 })
    expect(state.get('shell.conversation')).toBe(1)
    expect(state.get('shell.panel')).toBeUndefined()
  })
})

/** A sync state; `writes` is given as an object. */
const sync = (
  over: Partial<Omit<SyncState, 'writes'>> & { writes?: Record<string, Write> } = {},
): SyncState => ({
  remote: {},
  batch: 0,
  stream: { phase: 'live', shown: 0 },
  send: { phase: 'idle' },
  ...over,
  writes: new Map(Object.entries(over.writes ?? {})),
})
const pending = (value?: JsonValue): Write => ({ phase: 'pending', value })
const sentIn = (batch: number, value?: JsonValue): Write => ({ phase: 'sent', value, batch })
const acked = (rev: number, value?: JsonValue): Write => ({ phase: 'acknowledged', value, rev })
const sending = (batch: number) => ({ phase: 'sending', batch }) as const
const debouncing = (delayMs: number) => ({ phase: 'debouncing', delayMs }) as const
const set = (key: string, value: JsonValue | undefined, delayMs = 150): SyncEvent => ({
  type: 'set',
  key,
  value,
  delayMs,
})
const snapshot = (rev: number, values: Record<string, JsonValue> = {}): SyncEvent => ({
  type: 'snapshot',
  rev,
  values: { ...values, [UI_REVISION]: rev },
})
const values = (rev: number, v: Record<string, JsonValue> = {}) => ({ ...v, [UI_REVISION]: rev })

describe('durable UI state transitions', () => {
  const live = (shown: number) => ({ phase: 'live', shown }) as const
  const remote = values(5)
  const rows: [string, SyncState, SyncEvent, SyncState][] = [
    // set
    [
      'a write is pending and arms the debounce',
      sync(),
      set('panel', 'info'),
      sync({ writes: { panel: pending('info') }, send: debouncing(150) }),
    ],
    [
      'a delete is a pending write without a value',
      sync({ remote: { panel: 'info' } }),
      set('panel', undefined),
      sync({ remote: { panel: 'info' }, writes: { panel: pending() }, send: debouncing(150) }),
    ],
    [
      'a write equal to what is shown changes nothing',
      sync({ remote: { panel: 'info' }, writes: { view: pending('a') } }),
      set('view', 'a'),
      sync({ remote: { panel: 'info' }, writes: { view: pending('a') } }),
    ],
    [
      'a write while the timer runs keeps the earlier deadline',
      sync({ writes: { a: pending(1) }, send: debouncing(150) }),
      set('b', 2, 0),
      sync({ writes: { a: pending(1), b: pending(2) }, send: debouncing(150) }),
    ],
    [
      // 54c001bd: batch 1's answer must not confirm the newer value
      'a key written again while its batch is in flight is pending, so the old answer cannot confirm it',
      sync({ batch: 1, writes: { panel: sentIn(1, 'first') }, send: sending(1) }),
      set('panel', 'second'),
      sync({ batch: 1, writes: { panel: pending('second') }, send: sending(1) }),
    ],
    // flush
    [
      'the timer sends every pending write as the next batch',
      sync({
        batch: 4,
        writes: { a: pending(1), b: acked(9, 2) },
        send: debouncing(150),
      }),
      { type: 'flush', force: false },
      sync({
        batch: 5,
        writes: { a: sentIn(5, 1), b: acked(9, 2) },
        send: sending(5),
      }),
    ],
    [
      // 9c7def1b: one batch in flight keeps the server's commits in write order
      'the timer sends nothing while a batch is in flight',
      sync({ batch: 1, writes: { a: sentIn(1, 1), b: pending(2) }, send: sending(1) }),
      { type: 'flush', force: false },
      sync({ batch: 1, writes: { a: sentIn(1, 1), b: pending(2) }, send: sending(1) }),
    ],
    [
      'a page going away sends even with a batch in flight',
      sync({ batch: 1, writes: { a: sentIn(1, 1), b: pending(2) }, send: sending(1) }),
      { type: 'flush', force: true },
      sync({ batch: 2, writes: { a: sentIn(1, 1), b: sentIn(2, 2) }, send: sending(2) }),
    ],
    [
      'flushing with nothing pending stops the debounce',
      sync({ send: debouncing(150) }),
      { type: 'flush', force: true },
      sync(),
    ],
    // acknowledged
    [
      'an answer ahead of the stream keeps the write shown',
      sync({ batch: 1, stream: live(5), writes: { panel: sentIn(1, 'a') }, send: sending(1) }),
      { type: 'acknowledged', batch: 1, rev: 7 },
      sync({ batch: 1, stream: live(5), writes: { panel: acked(7, 'a') } }),
    ],
    [
      // 62cb5f32: the stream already showed the commit, so the answer settles it
      'an answer the stream already reached releases the write',
      sync({ batch: 1, stream: live(7), writes: { panel: sentIn(1, 'a') }, send: sending(1) }),
      { type: 'acknowledged', batch: 1, rev: 7 },
      sync({ batch: 1, stream: live(7) }),
    ],
    [
      'an answer sends the writes that waited for it next',
      sync({ batch: 1, writes: { a: sentIn(1, 1), b: pending(2) }, send: sending(1) }),
      { type: 'acknowledged', batch: 1, rev: 3 },
      sync({ batch: 1, writes: { a: acked(3, 1), b: pending(2) }, send: debouncing(0) }),
    ],
    [
      // 54c001bd: the rewritten key is not this batch's write
      'an answer leaves a key written again alone',
      sync({
        batch: 1,
        stream: live(9),
        writes: { panel: pending('second'), view: sentIn(1, 'v') },
        send: sending(1),
      }),
      { type: 'acknowledged', batch: 1, rev: 3 },
      sync({
        batch: 1,
        stream: live(9),
        writes: { panel: pending('second') },
        send: debouncing(0),
      }),
    ],
    [
      // 355dd0c0: a restarted stream releases nothing until its first snapshot
      'an answer from the new process keeps the write until its first snapshot',
      sync({
        batch: 2,
        stream: { phase: 'restarting' },
        writes: { a: sentIn(2, 1) },
        send: sending(2),
      }),
      { type: 'acknowledged', batch: 2, rev: 1 },
      sync({ batch: 2, stream: { phase: 'restarting' }, writes: { a: acked(1, 1) } }),
    ],
    [
      // 3b3ba88e: batch 1 went to the old process
      'a late answer from the old process changes nothing',
      sync({
        batch: 2,
        stream: { phase: 'restarting' },
        writes: { a: acked(0, 1), b: sentIn(2, 2) },
        send: sending(2),
      }),
      { type: 'acknowledged', batch: 1, rev: 40 },
      sync({
        batch: 2,
        stream: { phase: 'restarting' },
        writes: { a: acked(0, 1), b: sentIn(2, 2) },
        send: sending(2),
      }),
    ],
    // rejected
    [
      'a refused batch drops its writes and keeps a key written again',
      sync({
        batch: 1,
        writes: { a: sentIn(1, 1), b: sentIn(1, 2), a2: pending(3) },
        send: sending(1),
      }),
      { type: 'rejected', batch: 1 },
      sync({ batch: 1, writes: { a2: pending(3) }, send: debouncing(0) }),
    ],
    [
      'a refused batch with nothing waiting returns to idle',
      sync({ batch: 1, writes: { a: sentIn(1, 1) }, send: sending(1) }),
      { type: 'rejected', batch: 1 },
      sync({ batch: 1 }),
    ],
    [
      // 3b3ba88e
      'a failure from the old process drops nothing',
      sync({ batch: 2, stream: { phase: 'restarting' }, writes: { a: acked(0, 1) } }),
      { type: 'rejected', batch: 1 },
      sync({ batch: 2, stream: { phase: 'restarting' }, writes: { a: acked(0, 1) } }),
    ],
    // snapshot
    [
      'a snapshot becomes the document and releases the writes it reached',
      sync({ stream: live(2), writes: { a: acked(3, 1), b: acked(4, 2), c: pending(3) } }),
      snapshot(3, { a: 1 }),
      sync({
        remote: values(3, { a: 1 }),
        stream: live(3),
        writes: { b: acked(4, 2), c: pending(3) },
      }),
    ],
    [
      // 54c001bd: A → B → A
      'a snapshot of an earlier commit with an equal value releases nothing newer',
      sync({ stream: live(1), writes: { panel: acked(5, 'info') } }),
      snapshot(2, { panel: 'info' }),
      sync({
        remote: values(2, { panel: 'info' }),
        stream: live(2),
        writes: { panel: acked(5, 'info') },
      }),
    ],
    [
      // 62cb5f32
      'a snapshot older than one already shown is dropped',
      sync({ remote: values(5, { panel: 'new' }), stream: live(5) }),
      snapshot(4, { panel: 'old' }),
      sync({ remote: values(5, { panel: 'new' }), stream: live(5) }),
    ],
    [
      'the same document again changes nothing',
      sync({ remote, stream: live(5), writes: { a: acked(6, 1) } }),
      { type: 'snapshot', rev: 5, values: remote },
      sync({ remote, stream: live(5), writes: { a: acked(6, 1) } }),
    ],
    [
      // 3b3ba88e: the new storage counts from scratch; 355dd0c0: and then settles the kept writes
      'a restarted process’s first snapshot is taken whatever its revision and releases the kept writes',
      sync({
        remote: values(40, { panel: 'old' }),
        stream: { phase: 'restarting' },
        writes: { panel: acked(0, 'mine'), view: acked(9, 'v') },
      }),
      snapshot(1, { panel: 'mine' }),
      sync({
        remote: values(1, { panel: 'mine' }),
        stream: live(1),
        writes: { view: acked(9, 'v') },
      }),
    ],
    // restarted
    [
      // 355dd0c0: nothing is rolled back meanwhile; 3b3ba88e: unsent edits go to the new server
      'a restart keeps sent writes shown, awaiting the new snapshot, and sends unsent ones',
      sync({
        batch: 3,
        stream: live(40),
        writes: { a: sentIn(3, 1), b: acked(41, 2), c: pending(3) },
        send: sending(3),
      }),
      { type: 'restarted' },
      sync({
        batch: 3,
        stream: { phase: 'restarting' },
        writes: { a: acked(0, 1), b: acked(0, 2), c: pending(3) },
        send: debouncing(0),
      }),
    ],
    [
      'a restart with nothing unsent goes idle',
      sync({ batch: 3, writes: { a: sentIn(3, 1) }, send: sending(3) }),
      { type: 'restarted' },
      sync({ batch: 3, stream: { phase: 'restarting' }, writes: { a: acked(0, 1) } }),
    ],
    [
      'a restart keeps a debounce already running',
      sync({ writes: { c: pending(3) }, send: debouncing(150) }),
      { type: 'restarted' },
      sync({ stream: { phase: 'restarting' }, writes: { c: pending(3) }, send: debouncing(150) }),
    ],
  ]
  it.each(rows)('%s', (_name, from, event, expected) => {
    expect(step(from, event)).toEqual(expected)
  })
})
