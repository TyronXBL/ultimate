import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { removeTemp, temp } from '../../../test/helpers.ts'
import { writeSecret } from '../../secrets/store.ts'
import { previewEnv } from '../../instance/server.ts'
import { reserveSearch } from '../budget.ts'
import searxng from '../server.ts'

const homes: string[] = []
beforeEach(() => {
  vi.stubEnv('ULTIMATE_WEB_SEARCH_STATE_HOME', undefined)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const home of homes.splice(0)) await removeTemp(home)
})

type Scenario = {
  primary: 'results' | 'empty' | 'down' | 'down-results'
  key: boolean
  cap: boolean | 'corrupt'
  tavily: 'ok' | 'error'
  outcome: string
  fallback?: string
  calls: number
  count?: number
}
const table: [
  Scenario['primary'],
  Scenario['key'],
  Scenario['cap'],
  Scenario['tavily'],
  string,
  string | undefined,
  number,
  number?,
][] = [
  // primary, key, cap used up, Tavily, outcome, fallback, Tavily calls, count
  ['results', false, false, 'error', 'good', undefined, 0],
  ['empty', false, false, 'error', 'unknown-empty', 'not-configured', 0],
  ['empty', true, false, 'ok', 'fallback', 'answered', 1],
  ['empty', true, false, 'ok', 'fallback', 'answered', 1, 15],
  ['empty', true, false, 'ok', 'fallback', 'answered', 1, 25],
  ['empty', true, false, 'error', 'unknown-empty', 'failed', 1],
  ['down', false, false, 'ok', 'outage', 'not-configured', 0],
  ['down', true, true, 'ok', 'outage', 'cap-reached', 0],
  ['down', true, 'corrupt', 'ok', 'outage', 'budget-unavailable', 0],
  ['down', true, false, 'ok', 'fallback', 'answered', 1],
  ['down', true, false, 'error', 'outage', 'failed', 1],
  ['down-results', true, false, 'ok', 'fallback', 'answered', 1],
  // Other engines' results stay a success when the fallback cannot help.
  ['down-results', true, false, 'error', 'partial', 'failed', 1],
]
it.each<Scenario>(
  table.map(([primary, key, cap, tavily, outcome, fallback, calls, count]) => ({
    primary,
    key,
    cap,
    tavily,
    outcome,
    fallback,
    calls,
    count,
  })),
)('search decision: $primary, key=$key cap=$cap Tavily=$tavily', async (scenario) => {
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
            {
              name: 'yahoo',
              enabled: true,
              categories: ['general', 'web'],
              time_range_support: true,
            },
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
        max_results: 20,
      })
      calls++
      return scenario.tavily === 'ok'
        ? Response.json({
            results: Array.from({ length: 20 }, (_, index) => ({
              url: `https://example.org/${index}`,
              title: 'Fallback',
              content: 'result',
            })),
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
  const { count } = scenario
  const result = (await tool.execute(
    { query: 'test', count },
    { details } as never,
    {} as never,
  )) as {
    isError?: boolean
    output: { text: string }[]
  }
  const recorded = details.mock.calls[0][0] as { outcome: string; fallback?: string | null }
  expect(recorded.outcome).toBe(scenario.outcome)
  expect(recorded.fallback ?? undefined).toBe(scenario.fallback)
  expect(Boolean(result.isError)).toBe(scenario.outcome === 'outage')
  expect(calls).toBe(scenario.calls)
  const stored = details.mock.calls[0][0] as { results?: unknown[] }
  expect(stored.results?.length ?? 0).toBe(
    scenario.outcome === 'fallback'
      ? Math.min(count ?? 10, 20)
      : scenario.primary === 'results' || scenario.primary === 'down-results'
        ? 1
        : 0,
  )
  expect(result.output[0].text.includes('Tavily returns at most 20 results.')).toBe(
    scenario.outcome === 'fallback' && (count ?? 10) > 20,
  )
  expect(result.output[0].text.includes('Results from Tavily')).toBe(
    scenario.outcome === 'fallback',
  )
  expect(result.output[0].text.includes('may be a real empty result')).toBe(
    scenario.outcome === 'unknown-empty',
  )
  expect(result.output[0].text.includes('yahoo: timeout')).toBe(scenario.primary.startsWith('down'))
  const failure = !scenario.key
    ? 'not configured'
    : scenario.cap === true
      ? 'monthly limit of 1,000 calls is used up'
      : scenario.cap === 'corrupt'
        ? 'call counter'
        : 'Tavily fallback failed: Tavily answered HTTP 503.'
  expect(result.output[0].text.includes(failure)).toBe(
    ['outage', 'unknown-empty', 'partial'].includes(scenario.outcome) && !!scenario.fallback,
  )
  expect(
    result.output[0].text.startsWith('Web search is down: every SearXNG web engine failed'),
  ).toBe(scenario.outcome === 'outage')
})

it('shares a host budget with a preview while keeping private user homes isolated', async () => {
  const root = await temp()
  homes.push(root)
  const parent = join(root, 'parent')
  const preview = join(root, 'preview')
  await writeSecret(parent, 'TAVILY_API_KEY', 'test-key')
  await writeSecret(preview, 'TAVILY_API_KEY', 'test-key')
  vi.stubGlobal(
    'fetch',
    vi.fn<(input: string | URL) => Promise<Response>>(async (input) =>
      String(input).startsWith('https://api.tavily.com/')
        ? Response.json({ results: [{ url: 'https://example.org', title: 'Result' }] })
        : Response.json({ results: [], unresponsive_engines: [] }),
    ),
  )
  const search = async (userHome: string) => {
    const host = {
      userHome,
      notice: () => {},
      resource: <T>(_key: string, create: () => T) => create(),
      onClose: () => {},
    } as unknown as ExtensionHost
    const tool = searxng(host).tools![0]
    const details = vi.fn<(value: unknown) => Promise<void>>(async () => {})
    await tool.execute({ query: 'test' }, { details } as never, {} as never)
    return details.mock.calls[0][0] as { outcome: string }
  }
  expect((await search(parent)).outcome).toBe('fallback')
  const env = previewEnv(
    {},
    { home: root, project: root, userHome: preview, parentUserHome: parent, ownerPid: 1 },
  )
  vi.stubEnv('ULTIMATE_WEB_SEARCH_STATE_HOME', env.ULTIMATE_WEB_SEARCH_STATE_HOME)
  expect((await search(preview)).outcome).toBe('fallback')
  const db = new DatabaseSync(join(parent, '.ultimate/tavily-budget.sqlite'))
  expect(db.prepare('SELECT used FROM budget').get()).toEqual({ used: 2 })
  db.close()
  await expect(access(join(preview, '.ultimate/tavily-budget.sqlite'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await expect(
    access(join(preview, '.ultimate/web-search-admission.sqlite')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
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
