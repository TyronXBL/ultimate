import type { JsonValue } from '@earendil-works/chord'
import { UI_REVISION } from '../../../shared/protocol.ts'
import type { UiUpdateRequest, UiUpdateResponse } from '../../../shared/protocol.ts'

/**
 * Durable UI state: the flat JSON map of the root conversation's `ultimate.ui` document, shared by every tab and
 * device, such as which conversation, panel, and view the shell shows. Writes apply locally at once, reach the server
 * coalesced (`POST /api/ui`), and stay overlaid until the stream shows the commit that carried them.
 *
 * Every write commit increments the document's `ui.rev` and answers with it. The stream delivers commits in order,
 * but a reconnect starts from a snapshot that may predate this tab's newest write; ordered by revision, a snapshot
 * older than one already shown is dropped, and a write stays until the stream reaches its revision. Equal values are
 * never taken as confirmation (A → B → A), and the latest commit wins across tabs and devices.
 *
 * Without `write`, the page keeps its state to itself: writes apply locally and stay, nothing reaches the server.
 */
export type UiValues = Readonly<Record<string, JsonValue>>

/**
 * The newest local write of one key (`undefined` deletes it) and where it is: waiting to be sent, sent as a batch,
 * or answered with the revision it committed as. Each write is confirmed by its own batch, never by an equal value.
 */
export type Write =
  | { phase: 'pending'; value: JsonValue | undefined }
  | { phase: 'sent'; value: JsonValue | undefined; batch: number }
  | { phase: 'acknowledged'; value: JsonValue | undefined; rev: number }

export interface SyncState {
  /** The document as the stream last delivered it. */
  remote: UiValues
  writes: ReadonlyMap<string, Write>
  /** The last batch number issued; numbers are never reused, so a reply names the batch it answers. */
  batch: number
  /** After a restart, until the new process's first snapshot: nothing is released, since its revisions start over. */
  stream: { phase: 'live'; shown: number } | { phase: 'restarting' }
  /** One batch is in flight at a time, so the server commits them in write order. */
  send:
    | { phase: 'idle' }
    | { phase: 'debouncing'; delayMs: number }
    | { phase: 'sending'; batch: number }
}

export type SyncEvent =
  | { type: 'set'; key: string; value: JsonValue | undefined; delayMs: number }
  /** The debounce timer ran out, or (`force`) the page is going away: send what is pending as one batch. */
  | { type: 'flush'; force: boolean }
  | { type: 'acknowledged'; batch: number; rev: number }
  | { type: 'rejected'; batch: number }
  | { type: 'snapshot'; rev: number; values: UiValues }
  | { type: 'restarted' }

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)
const revision = (values: UiValues) => {
  const rev = values[UI_REVISION]
  return typeof rev === 'number' ? rev : 0
}
const hasPending = (writes: ReadonlyMap<string, Write>) =>
  [...writes.values()].some((write) => write.phase === 'pending')
/** Where the sender goes once nothing is in flight: straight to the next batch if writes wait. */
const settle = (writes: ReadonlyMap<string, Write>, send: SyncState['send']): SyncState['send'] =>
  send.phase === 'debouncing'
    ? send
    : hasPending(writes)
      ? { phase: 'debouncing', delayMs: 0 }
      : { phase: 'idle' }
/** Drop the overlay of writes the stream has shown: it is the truth for them now. */
function release(state: SyncState): SyncState {
  const { stream } = state
  if (stream.phase === 'restarting') return state
  const writes = new Map(state.writes)
  for (const [key, write] of writes)
    if (write.phase === 'acknowledged' && write.rev <= stream.shown) writes.delete(key)
  return { ...state, writes }
}
/** Writes already sent to `batch` are replaced by `next`, which answers for them. */
function answer(state: SyncState, batch: number, next: (write: Write) => Write | undefined) {
  const writes = new Map(state.writes)
  for (const [key, write] of writes) {
    if (write.phase !== 'sent' || write.batch !== batch) continue
    const answered = next(write)
    if (answered) writes.set(key, answered)
    else writes.delete(key)
  }
  const send =
    state.send.phase === 'sending' && state.send.batch === batch
      ? settle(writes, state.send)
      : state.send
  return { ...state, writes, send }
}

/** The only writer of the sync state. */
export function step(state: SyncState, event: SyncEvent): SyncState {
  switch (event.type) {
    case 'set': {
      const current = state.writes.get(event.key)
      if (same(current ? current.value : state.remote[event.key], event.value)) return state
      const writes = new Map(state.writes).set(event.key, {
        phase: 'pending',
        value: event.value,
      })
      const send: SyncState['send'] =
        state.send.phase === 'idle' ? { phase: 'debouncing', delayMs: event.delayMs } : state.send
      return { ...state, writes, send }
    }
    case 'flush': {
      if (state.send.phase === 'sending' && !event.force) return state
      if (!hasPending(state.writes))
        return state.send.phase === 'debouncing' ? { ...state, send: { phase: 'idle' } } : state
      const batch = state.batch + 1
      const writes = new Map(state.writes)
      for (const [key, write] of writes)
        if (write.phase === 'pending') writes.set(key, { phase: 'sent', value: write.value, batch })
      return { ...state, writes, batch, send: { phase: 'sending', batch } }
    }
    case 'acknowledged':
      return release(
        answer(state, event.batch, ({ value }) => ({
          phase: 'acknowledged',
          value,
          rev: event.rev,
        })),
      )
    case 'rejected':
      return answer(state, event.batch, () => undefined)
    case 'snapshot': {
      if (event.values === state.remote) return state
      if (state.stream.phase === 'live' && event.rev < state.stream.shown) return state
      return release({
        ...state,
        remote: event.values,
        stream: { phase: 'live', shown: event.rev },
      })
    }
    case 'restarted': {
      // Every batch already sent went to the old storage: it stays shown until the new process's snapshot, and its
      // late reply finds nothing to answer. Edits not yet sent go to the new server.
      const writes = new Map(state.writes)
      for (const [key, write] of writes)
        if (write.phase !== 'pending')
          writes.set(key, { phase: 'acknowledged', value: write.value, rev: 0 })
      return { ...state, writes, stream: { phase: 'restarting' }, send: settle(writes, state.send) }
    }
    default:
      return event satisfies never
  }
}

/** What the UI reads: the document with the local writes laid over it. */
function view({ remote, writes }: SyncState): UiValues {
  const next: Record<string, JsonValue> = { ...remote }
  for (const [key, { value }] of writes) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

export function createUiState(
  write: ((change: UiUpdateRequest) => Promise<UiUpdateResponse>) | undefined,
  options: { delayMs?: number; onError?: (error: unknown) => void } = {},
) {
  const listeners = new Set<() => void>()
  let state: SyncState = {
    remote: {},
    writes: new Map(),
    batch: 0,
    stream: { phase: 'live', shown: 0 },
    send: { phase: 'idle' },
  }
  let values: UiValues = {}
  let timer: ReturnType<typeof setTimeout> | undefined

  /** Apply an event, then do what the new state calls for: send the batch it opened, arm or clear the timer, notify. */
  function dispatch(event: SyncEvent) {
    const before = state
    state = step(state, event)
    const { send } = state
    if (send.phase === 'debouncing') {
      if (write && timer === undefined)
        timer = setTimeout(() => {
          timer = undefined
          dispatch({ type: 'flush', force: false })
        }, send.delayMs)
    } else {
      clearTimeout(timer)
      timer = undefined
    }
    if (
      write &&
      send.phase === 'sending' &&
      !(before.send.phase === 'sending' && before.send.batch === send.batch)
    )
      post(write, send.batch)
    const next = view(state)
    const keys = new Set([...Object.keys(values), ...Object.keys(next)])
    if ([...keys].every((key) => values[key] === next[key])) return
    values = next
    for (const listener of listeners) listener()
  }
  function post(request: NonNullable<typeof write>, batch: number) {
    const change: UiUpdateRequest = { set: {}, delete: [] }
    for (const [key, entry] of state.writes) {
      if (entry.phase !== 'sent' || entry.batch !== batch) continue
      if (entry.value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = entry.value
    }
    request(change).then(
      ({ rev }) => dispatch({ type: 'acknowledged', batch, rev }),
      (error: unknown) => {
        // An old process's failed reply is about storage the stream no longer shows: nothing to report.
        const live = [...state.writes.values()].some(
          (entry) => entry.phase === 'sent' && entry.batch === batch,
        )
        dispatch({ type: 'rejected', batch })
        if (live) options.onError?.(error)
      },
    )
  }
  const set = (key: string, value: JsonValue | undefined) =>
    dispatch({ type: 'set', key, value, delayMs: options.delayMs ?? 150 })

  return {
    get: (key: string): JsonValue | undefined => values[key],
    snapshot: (): UiValues => values,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (key: string, value: JsonValue) => set(key, value),
    delete: (key: string) => set(key, undefined),
    /** The document as the stream last delivered it; a snapshot older than one already shown is dropped. */
    receive: (next: UiValues) => dispatch({ type: 'snapshot', rev: revision(next), values: next }),
    /**
     * The server is another process now, whose storage may have started over (`pnpm reset`): take its next snapshot
     * whatever its revision.
     */
    restarted: () => dispatch({ type: 'restarted' }),
    /** Send what is pending now, such as before the page goes away. */
    flush: () => dispatch({ type: 'flush', force: true }),
  }
}
