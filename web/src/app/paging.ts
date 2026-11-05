/**
 * What a transcript's reads of stored history are doing: paging into earlier history, and filling the ranges a fresh
 * window does not cover. `TranscriptEntries` performs the reads; `step` is the only writer of their state, and
 * `pagingView` is what every reader of it sees.
 */

/** The stored entries after `after` up to `upTo`. */
export type Range = readonly [after: number, upTo: number]

/**
 * Where paging is. `before`: the oldest entry a page read, which the next page reads before; until the first page,
 * the window's `older`. `loading`: read `request` is reading a page. `failed`: it failed, until Retry. `start`: the
 * pages reached the conversation's first entry.
 */
export type Page =
  | { phase: 'idle'; before?: number }
  | { phase: 'loading'; before?: number; request: number }
  | { phase: 'failed'; before?: number; error: string }
  | { phase: 'start' }

/** A fill of one range: reading, failed until Retry, or released by Retry for the transcript to read again. */
export type Fill =
  | { phase: 'running'; range: Range }
  | { phase: 'failed'; range: Range; error: string }
  | { phase: 'retrying'; range: Range }

export interface Paging {
  page: Page
  fills: readonly Fill[]
}

/** `loaded` reached the start when it has no `before`; `loadedDown` read the pages down to `target`. */
export type PagingEvent =
  | { type: 'load'; request: number }
  | { type: 'loaded'; request: number; before: number | undefined }
  | { type: 'loadedDown'; request: number; target: number }
  | { type: 'failed'; request: number; error: string }
  | { type: 'aborted'; request: number }
  | { type: 'fill'; range: Range }
  | { type: 'filled'; range: Range }
  | { type: 'fillFailed'; range: Range; error: string }
  | { type: 'retry' }

export const initialPaging: Paging = { page: { phase: 'idle' }, fills: [] }

/** The page is loading as `request`: a reply to any other read is stale, from one aborted or superseded. */
const reading = (page: Page, request: number): page is Extract<Page, { phase: 'loading' }> =>
  page.phase === 'loading' && page.request === request
const without = (fills: readonly Fill[], [after, upTo]: Range) =>
  fills.filter(({ range }) => range[0] !== after || range[1] !== upTo)

/** The only writer of the paging state: what `event` does in `state` (nothing, when it does not apply). */
export function step(state: Paging, event: PagingEvent): Paging {
  const { page, fills } = state
  switch (event.type) {
    // One page at a time, from a cursor, and not past a failure until Retry.
    case 'load':
      return page.phase === 'idle'
        ? { page: { phase: 'loading', before: page.before, request: event.request }, fills }
        : state
    case 'loaded':
      if (!reading(page, event.request)) return state
      return {
        page:
          event.before === undefined ? { phase: 'start' } : { phase: 'idle', before: event.before },
        fills,
      }
    // Down to a revealed row only: the start may still lie below it.
    case 'loadedDown':
      return reading(page, event.request)
        ? { page: { phase: 'idle', before: event.target }, fills }
        : state
    case 'failed':
      return reading(page, event.request)
        ? { page: { phase: 'failed', before: page.before, error: event.error }, fills }
        : state
    case 'aborted':
      return reading(page, event.request)
        ? { page: { phase: 'idle', before: page.before }, fills }
        : state
    case 'fill':
      return {
        page,
        fills: [...without(fills, event.range), { phase: 'running', range: event.range }],
      }
    case 'filled':
      return { page, fills: without(fills, event.range) }
    case 'fillFailed':
      return {
        page,
        fills: [
          ...without(fills, event.range),
          { phase: 'failed', range: event.range, error: event.error },
        ],
      }
    // Retry takes back every failure: the page pages on, failed fills read again.
    case 'retry':
      return {
        page: page.phase === 'failed' ? { phase: 'idle', before: page.before } : page,
        fills: fills.map((fill) =>
          fill.phase === 'failed' ? { phase: 'retrying', range: fill.range } : fill,
        ),
      }
    default:
      return event satisfies never
  }
}

/**
 * What the transcript reads. `cursor`: the entry the next page reads before, from the window's `older` until a page;
 * none at the start, or at the fork point of a fork (`forked`), whose earlier history is its source's. `pending`: a
 * page is loading. `error`: a page or fill failed, until Retry. `filling`: how many fills are reading.
 */
export function pagingView({ page, fills }: Paging, older: number | undefined, forked: boolean) {
  const failed = fills.findLast((fill) => fill.phase === 'failed')
  return {
    cursor: forked || page.phase === 'start' ? undefined : (page.before ?? older),
    pending: page.phase === 'loading',
    error: page.phase === 'failed' ? page.error : (failed?.error ?? ''),
    filling: fills.filter((fill) => fill.phase === 'running').length,
  }
}
