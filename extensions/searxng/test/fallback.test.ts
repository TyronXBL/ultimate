import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'
import { writeSecret } from '../../secrets/store.ts'
import { reserveSearch } from '../budget.ts'
import searxng from '../server.ts'

const homes: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const home of homes.splice(0)) await removeTemp(home)
})

it.each([
  { primary: 'results', key: false, cap: false, tavily: 'error', outcome: 'good', calls: 0 },
  { primary: 'empty', key: false, cap: false, tavily: 'error', outcome: 'unknown-empty', calls: 0 },
  { primary: 'empty', key: true, cap: false, tavily: 'ok', outcome: 'fallback', calls: 1 },
  { primary: 'empty', key: true, cap: false, tavily: 'error', outcome: 'unknown-empty', calls: 1 },
  { primary: 'down', key: false, cap: false, tavily: 'ok', outcome: 'outage', calls: 0 },
  { primary: 'down', key: true, cap: true, tavily: 'ok', outcome: 'outage', calls: 0 },
  { primary: 'down', key: true, cap: 'corrupt', tavily: 'ok', outcome: 'outage', calls: 0 },
  { primary: 'down', key: true, cap: false, tavily: 'ok', outcome: 'fallback', calls: 1 },
  { primary: 'down', key: true, cap: false, tavily: 'error', outcome: 'outage', calls: 1 },
  { primary: 'down-results', key: true, cap: false, tavily: 'ok', outcome: 'fallback', calls: 1 },
])('search decision: $primary, key=$key cap=$cap Tavily=$tavily', async (scenario) => {
  const userHome = await temp()
  homes.push(userHome)
  await mkdir(join(userHome, '.ultimate'))
  if (scenario.key) await writeSecret(userHome, 'TAVILY_API_KEY', 'test-key')
  if (scenario.cap === 'corrupt')
    await writeFile(join(userHome, '.ultimate/tavily-budget.sqlite'), 'invalid')
  if (scenario.cap === true) {
    await reserveSearch(userHome)
    const db = new DatabaseSync(join(userHome, '.ultimate/tavily-budget.sqlite'))
    db.exec('UPDATE budget SET used = 1000')
    db.close()
  }
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/config'))
        return Response.json({
          engines: [
            { name: 'yahoo', enabled: true, categories: ['general'], time_range_support: true },
          ],
        })
      if (url.includes('/search') && !url.includes('tavily.com'))
        return Response.json({
          results:
            scenario.primary === 'results'
              ? [{ url: 'https://example.com', title: 'Primary', engine: 'yahoo' }]
              : scenario.primary === 'down-results'
                ? [{ url: 'https://example.com', title: 'Code', engine: 'github' }]
                : [],
          unresponsive_engines: scenario.primary.startsWith('down') ? [['yahoo', 'timeout']] : [],
        })
      expect(url).toBe('https://api.tavily.com/search')
      expect(init?.redirect).toBe('error')
      expect(JSON.parse(init?.body as string)).toEqual({
        query: 'test',
        search_depth: 'basic',
        auto_parameters: false,
        max_results: 10,
      })
      calls++
      return scenario.tavily === 'ok'
        ? Response.json({
            results: [{ url: 'https://example.org', title: 'Fallback', content: 'result' }],
          })
        : new Response('', { status: 503 })
    }),
  )
  const host = {
    userHome,
    notice: () => {},
    resource: <T>(_key: string, create: () => T) => create(),
    onClose: () => {},
  } as unknown as ExtensionHost
  const tool = searxng(host).tools![0]
  const details = vi.fn<(value: unknown) => Promise<void>>(async () => {})
  const result = (await tool.execute({ query: 'test' }, { details } as never, {} as never)) as {
    isError?: boolean
    output: { text: string }[]
  }
  expect((details.mock.calls[0][0] as { outcome: string }).outcome).toBe(scenario.outcome)
  expect(Boolean(result.isError)).toBe(scenario.outcome === 'outage')
  expect(calls).toBe(scenario.calls)
  expect(result.output[0].text.includes('Results from Tavily')).toBe(
    scenario.outcome === 'fallback',
  )
  expect(result.output[0].text.includes('status is unknown')).toBe(
    scenario.outcome === 'unknown-empty',
  )
  expect(result.output[0].text.includes('yahoo: timeout')).toBe(scenario.primary.startsWith('down'))
  const failure = !scenario.key
    ? 'not configured'
    : scenario.cap === true
      ? 'monthly limit'
      : scenario.cap === 'corrupt'
        ? 'budget is unavailable'
        : 'Tavily request failed'
  expect(result.output[0].text.includes(failure)).toBe(
    scenario.outcome === 'outage' || scenario.outcome === 'unknown-empty',
  )
})

it('does not initiate fallback when a search is cancelled', async () => {
  const userHome = await temp()
  homes.push(userHome)
  await mkdir(join(userHome, '.ultimate'))
  await writeSecret(userHome, 'TAVILY_API_KEY', 'test-key')
  const controller = new AbortController()
  const fetch = vi.fn<() => Promise<Response>>(async () => {
    controller.abort()
    return Response.json({ results: [], unresponsive_engines: [] })
  })
  vi.stubGlobal('fetch', fetch)
  const host = {
    userHome,
    notice: () => {},
    resource: <T>(_key: string, create: () => T) => create(),
    onClose: () => {},
  } as unknown as ExtensionHost
  const tool = searxng(host).tools![0]
  const details = vi.fn<(value: unknown) => Promise<void>>(async () => {})
  const result = (await tool.execute(
    { query: 'test' },
    { details } as never,
    { abortSignal: controller.signal } as never,
  )) as { isError?: boolean }
  expect(result.isError).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((details.mock.calls[0][0] as { outcome: string }).outcome).toBe('cancelled')
})
