import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Dashboard } from '../../dashboard.tsx'
import type { MachineState } from '../../refs.ts'

vi.mock('@/sdk', async () => {
  const format = await import('../../../../web/src/sdk/format.ts')
  return {
    cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
    formatDuration: format.formatDuration,
    formatTime: format.formatTime,
    plural: format.plural,
    useUltimate: () => ({ showSurface: () => {}, switchConversation: () => {} }),
    useConversations: () => [{ id: 12, title: 'Build the Activity feed' }],
  }
})

const now = Date.parse('2026-10-19T18:40:00Z')
const ago = (seconds: number) => now - seconds * 1000

const state: MachineState = {
  now,
  project: 'ultimate',
  cores: 6,
  totalMiB: 16_384,
  swapTotalMiB: 4096,
  floorMiB: 3072,
  samples: [
    {
      at: ago(3),
      load: 28.4,
      cpu: { work: 4.2, job: 1, host: 0.3 },
      availableMiB: 3500,
      swapUsedMiB: 4000,
      running: 1,
      waiting: 2,
    },
  ],
  queue: [
    {
      id: 'a',
      label: 'pnpm test',
      from: '#12 in ultimate',
      project: 'ultimate',
      conversation: 12,
      at: ago(400),
      state: 'running',
      since: ago(252),
      cpu: 1,
      rssMiB: 900,
    },
    {
      id: 'b',
      label: 'pnpm check',
      from: '#40 in my-app',
      project: 'my-app',
      conversation: 40,
      at: ago(200),
      state: 'waiting',
      position: 1,
      reason: { kind: 'behind', label: 'pnpm test', from: '#12 in ultimate' },
    },
    {
      id: 'c',
      label: 'vitest run',
      from: '#12 in ultimate',
      project: 'ultimate',
      conversation: 12,
      at: ago(100),
      state: 'waiting',
      position: 2,
      reason: { kind: 'ram', availableMiB: 3500, needMiB: 2048, floorMiB: 3072 },
    },
  ],
  owners: [
    {
      key: 'work:my-app:40',
      kind: 'work',
      project: 'my-app',
      conversation: 40,
      label: 'node playwright',
      cpu: 4.2,
      rssMiB: 2100,
      processes: 9,
      since: ago(600),
    },
    {
      key: 'host:ultimate',
      kind: 'host',
      project: 'ultimate',
      label: 'ultimate',
      cpu: 0.3,
      rssMiB: 800,
      processes: 4,
      since: ago(9000),
    },
  ],
  more: { owners: 0, cpu: 0, rssMiB: 0 },
  temp: [],
  pressure: [{ kind: 'outside', cores: 4.2 }],
}

/** The rows of the section marked `data-<section>`, as the text a person reads. */
function read(section: string, row: string) {
  const html = renderToStaticMarkup(createElement(Dashboard, { state, samples: state.samples }))
  const body = new RegExp(`data-${section}[^>]*>(.*?)</section>`, 's').exec(html)?.[1] ?? ''
  return [...body.matchAll(new RegExp(`<li[^>]*${row}[^>]*>(.*?)</li>`, 'gs'))].map(
    ([whole, inner]) => ({
      marked: whole,
      text: inner
        .replaceAll(/<[^>]+>/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim(),
    }),
  )
}

it('shows the running job, then the waiters in order with why each waits', () => {
  const queue = read('machine-queue', 'data-job')
  const rows = queue.map((row) => row.text)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toContain('pnpm test')
  expect(rows[0]).toContain('Build the Activity feed #12')
  expect(rows[0]).toContain('running 4m 12s')
  expect(rows[0]).toContain('1.0 cores · 900 MB')
  // Behind the job above it, said on hover rather than repeated under it.
  expect(rows[1]).toBe('1 pnpm check #40 in my-app waiting 3m 20s')
  expect(queue[1].marked).toContain('behind pnpm test (#12 in ultimate)')
  expect(rows[2]).toMatch(
    /^2 vitest run Build the Activity feed #12 waiting 1m 40s RAM short: 3\.4 GB free, needs 2\.0 GB above the 3\.0 GB floor$/,
  )
})

it('marks work outside the queue that burns cores, and says so in the head', () => {
  const owners = read('machine-owners', 'data-owner')
  expect(owners.map((row) => row.text)).toEqual([
    'node playwright 4.2 cores work outside the queue #40 in my-app 2.1 GB',
    'ultimate 0.3 cores Ultimate ultimate 800 MB',
  ])
  expect(owners[0].marked).toContain('data-outside')
  expect(owners[1].marked).not.toContain('data-outside')
  const html = renderToStaticMarkup(createElement(Dashboard, { state, samples: state.samples }))
  expect(html.replaceAll(/<[^>]+>/g, ' ')).toContain('Work outside the queue uses 4.2 cores')
})

it('says the queue is empty when nothing runs or waits', () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, { state: { ...state, queue: [] }, samples: state.samples }),
  )
  expect(html).toContain('Queue empty: the next heavy job starts at once')
})
