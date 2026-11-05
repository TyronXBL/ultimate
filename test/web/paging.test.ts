import { describe, expect, it } from 'vitest'
import { initialPaging, pagingView, step } from '../../web/src/app/paging.ts'
import type { Fill, Page, Paging, PagingEvent, Range } from '../../web/src/app/paging.ts'

const gap: Range = [11, 20]
const other: Range = [31, 40]
const at = (page: Page, fills: readonly Fill[] = []): Paging => ({ page, fills })
const idle = (before?: number): Page => ({ phase: 'idle', before })
const loading = (before?: number): Page => ({ phase: 'loading', before })
const failed = (before?: number): Page => ({ phase: 'failed', before })
const start: Page = { phase: 'start' }
const running = (range: Range): Fill => ({ phase: 'running', range })
const fillFailed = (range: Range): Fill => ({ phase: 'failed', range })

describe('transcript paging', () => {
  const rows: [string, Paging, PagingEvent, Paging][] = [
    ['a page starts from idle', initialPaging, { type: 'load' }, at(loading())],
    [
      'a page with more before it pages on from its oldest entry',
      at(loading()),
      { type: 'loaded', before: 400 },
      at(idle(400)),
    ],
    [
      'a page reaching the first entry stops paging',
      at(loading(400)),
      { type: 'loaded', before: undefined },
      at(start),
    ],
    [
      'a failed page keeps its cursor until Retry',
      at(loading(400)),
      { type: 'failed' },
      at(failed(400)),
    ],
    [
      'Retry pages on and releases failed fills to read again',
      at(failed(400), [fillFailed(gap), running(other)]),
      { type: 'retry' },
      at(idle(400), [{ phase: 'retrying', range: gap }, running(other)]),
    ],
    [
      'a reveal reads down to its target, which the next page reads before',
      at(loading(400)),
      { type: 'loadedDown', target: 120 },
      at(idle(120)),
    ],
    ['no second page while one loads', at(loading(400)), { type: 'load' }, at(loading(400))],
    ['no page after a failure until Retry', at(failed(400)), { type: 'load' }, at(failed(400))],
    ['no page past the start', at(start), { type: 'load' }, at(start)],
    [
      'a fill reads beside a loading page',
      at(loading(), [running(other)]),
      { type: 'fill', range: gap },
      at(loading(), [running(other), running(gap)]),
    ],
    [
      'a retried fill reads again',
      at(idle(), [{ phase: 'retrying', range: gap }]),
      { type: 'fill', range: gap },
      at(idle(), [running(gap)]),
    ],
    [
      'a finished fill stops counting',
      at(idle(), [running(other), running(gap)]),
      { type: 'filled', range: gap },
      at(idle(), [running(other)]),
    ],
    [
      'a failed fill waits for Retry',
      at(loading(), [running(gap)]),
      { type: 'fillFailed', range: gap },
      at(loading(), [fillFailed(gap)]),
    ],
  ]
  it.each(rows)('%s', (_name, from, event, expected) => {
    expect(step(from, event)).toEqual(expected)
  })

  const views: [string, Paging, number | undefined, boolean, ReturnType<typeof pagingView>][] = [
    [
      'the window pages from its oldest entry until a page',
      initialPaging,
      500,
      false,
      { cursor: 500, pending: false, canLoad: true, failed: false, filling: 0 },
    ],
    [
      'a page moves the cursor past a fresh window',
      at(idle(400)),
      500,
      false,
      { cursor: 400, pending: false, canLoad: true, failed: false, filling: 0 },
    ],
    [
      'a whole stream has nothing earlier',
      initialPaging,
      undefined,
      false,
      { cursor: undefined, pending: false, canLoad: false, failed: false, filling: 0 },
    ],
    [
      'the start ends paging',
      at(start),
      500,
      false,
      { cursor: undefined, pending: false, canLoad: false, failed: false, filling: 0 },
    ],
    // 087a694f: a fork stops at its own fork point, its source's history stays hidden.
    [
      'a fork stops at its fork point',
      at(idle(400)),
      500,
      true,
      { cursor: undefined, pending: false, canLoad: false, failed: false, filling: 0 },
    ],
    [
      'a loading page shows, keeping its cursor',
      at(loading(400), [running(gap)]),
      500,
      false,
      { cursor: 400, pending: true, canLoad: false, failed: false, filling: 1 },
    ],
    [
      'a failed page shows Retry and pages no further',
      at(failed(400)),
      500,
      false,
      { cursor: 400, pending: false, canLoad: false, failed: true, filling: 0 },
    ],
    // 9d4d8c60: a failed fill shows Retry and holds paging, and Retry reruns it.
    [
      'a failed fill shows Retry while others read',
      at(idle(400), [fillFailed(gap), running(other)]),
      500,
      false,
      { cursor: 400, pending: false, canLoad: false, failed: true, filling: 1 },
    ],
    [
      'released fills show no Retry',
      at(idle(400), [{ phase: 'retrying', range: gap }]),
      500,
      false,
      { cursor: 400, pending: false, canLoad: true, failed: false, filling: 0 },
    ],
  ]
  it.each(views)('%s', (_name, paging, older, forked, expected) => {
    expect(pagingView(paging, older, forked)).toEqual(expected)
  })
})
