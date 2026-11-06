import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { api } from '../sdk/client.ts'
import { reachedFork } from './fork.ts'
import { initialPaging, pagingView, step } from './paging.ts'

/** `previous` with `rows` added, by entry id; a row read again replaces the earlier copy. */
export function mergeRows(previous: readonly EntryRecord[], rows: readonly EntryRecord[]) {
  const merged = new Map(previous.map((entry) => [entry.id, entry]))
  for (const entry of rows) merged.set(entry.id, entry)
  return [...merged.values()]
}

/**
 * Where a fresh window starting at `older` leaves stored history unread: the entry after the newest loaded row below
 * it, or `undefined` when no row below it is loaded (nothing to bridge) or it starts right there.
 */
export function gapAfter(loaded: readonly EntryRecord[], older: number) {
  const below = Math.max(0, ...loaded.flatMap((entry) => (entry.id < older ? [entry.id] : [])))
  return below && below + 1 < older ? below + 1 : undefined
}

/** Every stored entry of `id` below `upTo` (from `after` on, or one page without it), following the server's pages. */
async function read(id: number, upTo: number, after: number | undefined, signal?: AbortSignal) {
  const rows: EntryRecord[] = []
  let next: number | undefined = upTo
  do {
    const page = await api.history(id, next, signal, after)
    rows.push(...page.entries)
    next = page.before
    if (after === undefined) return { rows, before: next }
  } while (next !== undefined)
  return { rows, before: undefined }
}

/**
 * The stored history a transcript shows beyond its stream's window: what the reader paged in (`loadEarlier`), what a
 * reveal reads down to (`loadDown`), the rows a compaction or a fresh window moved past, and the gaps a fresh window
 * leaves below it. `entries` is all of it with the window, oldest first; `cursor` is where the next page starts, absent
 * when there is nothing earlier to show. What the reads are doing is the `paging.ts` state machine.
 */
export function useHistory(
  id: number | undefined,
  active: readonly EntryRecord[],
  older: number | undefined,
) {
  const [history, setHistory] = useState<EntryRecord[]>([])
  const [paging, dispatch] = useReducer(step, initialPaging)
  const previousActive = useRef(active)
  const previousOlder = useRef<number>(undefined)
  // The page read in flight, aborted when the transcript goes; fills run beside it. Set at once, it also keeps a second
  // read from starting in the same tick, before the loading phase renders.
  const request = useRef<AbortController | null>(null)
  // Ranges a fresh window does not cover, by their `after:upTo` key: discarded markers after a head marker, and what
  // arrived while a reconnect was away. Filled once each; failed ones wait for Retry. The keys only deduplicate reads;
  // what each fill is doing is in `paging`.
  const filled = useRef(new Set<string>())
  // A fork's history before its own first entry is its source's and stays hidden: paging stops at the fork point.
  const forked = reachedFork([...active, ...history], id)
  const { cursor, pending, canLoad, failed, filling } = pagingView(paging, older, forked)
  // Retain already displayed rows when a live compaction replaces the active context, or a fresh window moves past them.
  const entries = useMemo(
    () =>
      mergeRows(mergeRows(history, previousActive.current), active).toSorted((a, b) => a.id - b.id),
    [history, active],
  )
  const fill = useEffectEvent((after: number, upTo: number) => {
    const key = `${after}:${upTo}`
    if (id === undefined || filled.current.has(key)) return
    filled.current.add(key)
    const range = [after, upTo] as const
    dispatch({ type: 'fill', range })
    // oxlint-disable-next-line typescript/no-floating-promises -- this task catches history failures and reports them as fillFailed.
    void (async () => {
      try {
        const { rows } = await read(id, upTo, after)
        setHistory((previous) => mergeRows(previous, rows))
        dispatch({ type: 'filled', range })
      } catch {
        // The sentinel offers Retry, which reads the range again.
        filled.current.delete(key)
        dispatch({ type: 'fillFailed', range })
      }
    })()
  })
  useEffect(() => {
    for (const { phase, range } of paging.fills) if (phase === 'retrying') fill(...range)
  }, [paging.fills])
  const loadedBelow = useEffectEvent((dropped: readonly EntryRecord[]) => [...history, ...dropped])
  useLayoutEffect(() => {
    const current = new Set(active.map((entry) => entry.id))
    const dropped = previousActive.current.filter((entry) => !current.has(entry.id))
    if (dropped.length) setHistory((previous) => mergeRows(previous, dropped))
    // A fresh window (a new `older`; appends keep it) can leave stored history between it and the rows kept below it.
    if (older !== undefined && older !== previousOlder.current) {
      const after = gapAfter(loadedBelow(dropped), older)
      if (after !== undefined) fill(after, older)
    }
    previousOlder.current = older
    previousActive.current = active
  }, [active, older])
  useEffect(() => () => request.current?.abort(), [])
  /** Read from the cursor down (one page, or to `target`), then `arrived(rows)` before they show. */
  const load = async (target: number | undefined, arrived: (rows: EntryRecord[]) => void) => {
    if (id === undefined || request.current || !canLoad) return
    const controller = new AbortController()
    request.current = controller
    dispatch({ type: 'load' })
    try {
      const page = await read(id, cursor, target, controller.signal)
      if (controller.signal.aborted) return
      arrived(page.rows)
      setHistory((previous) => mergeRows(previous, page.rows))
      dispatch(
        target === undefined
          ? { type: 'loaded', before: page.before }
          : { type: 'loadedDown', target },
      )
    } catch {
      // Aborted: the transcript is gone, nothing reads its state. Otherwise the sentinel offers Retry.
      if (!controller.signal.aborted) dispatch({ type: 'failed' })
    } finally {
      request.current = null
    }
  }
  return {
    entries,
    history,
    cursor,
    pending,
    canLoad,
    failed,
    filling,
    /** Take back every failure; failed fills then run again, and paging goes on. */
    retry: () => dispatch({ type: 'retry' }),
    /** The page before the cursor; `arrived` sees its rows before they show. */
    loadEarlier: (arrived: (rows: EntryRecord[]) => void) => load(undefined, arrived),
    /** Stored history down to entry `target`, in large pages bounded by it, so a reveal can scroll there. */
    loadDown: (target: number, arrived: () => void) => load(target, arrived),
  }
}
