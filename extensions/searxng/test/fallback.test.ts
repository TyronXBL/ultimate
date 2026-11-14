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

/** The web_search tool over a fresh user home; `fetch` must be stubbed first. */
async function webSearch(userHome: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const host = {
    userHome,
    notice: () => {},
    resource: <T>(_key: string, create: () => T) => create(),
    onClose: () => {},
  } as unknown as ExtensionHost
  const details = vi.fn<(value: unknown) => Promise<void>>(async () => {})
  const result = (await searxng(host).tools![0].execute(
    args,
    { details } as never,
    {
      abortSignal: signal,
    } as never,
  )) as { isError?: boolean; output: { text: string }[] }
  const recorded = details.mock.calls[0][0] as {
    outcome: string
    fallback?: string | null
    results?: unknown[]
  }
  return { ...result, text: result.output[0].text, details: recorded }
}

/** SearXNG's answer: its results' engines and the engines it reports unresponsive. */
const primaries = {
  results: { engines: ['yahoo'], down: [] },
  empty: { engines: [], down: [] },
  // Every web engine failed; the general-only `example` engine is no web engine and proves nothing.
  down: { engines: [], down: ['yahoo', 'brave'] },
  'one-down': { engines: [], down: ['brave'] },
  // Every web engine failed, but a code engine still answered.
  'down-results': { engines: ['github'], down: ['yahoo', 'brave'] },
}

// primary, key (unreadable: a broken secret store), cap (true: used up), Tavily, outcome, fallback, Tavily calls,
// results shown, cause in the text
const table: [
  keyof typeof primaries,
  boolean | 'unreadable',
  boolean | 'corrupt',
  'ok' | 'empty' | 'error',
  string,
  string | undefined,
  number,
  number,
  string | undefined,
][] = [
  ['results', false, false, 'error', 'good', undefined, 0, 1, undefined],
  ['empty', false, false, 'error', 'unknown-empty', 'not-configured', 0, 0, 'not configured'],
  [
    'empty',
    'unreadable',
    false,
    'ok',
    'unknown-empty',
    'secrets-unreadable',
    0,
    0,
    'secret store could not be read',
  ],
  ['empty', true, false, 'ok', 'fallback', 'answered', 1, 10, undefined],
  ['empty', true, false, 'empty', 'empty', 'no-results', 1, 0, undefined],
  ['empty', true, false, 'error', 'unknown-empty', 'failed', 1, 0, 'HTTP 503'],
  ['one-down', false, false, 'error', 'unknown-empty', 'not-configured', 0, 0, 'not configured'],
  ['down', false, false, 'ok', 'outage', 'not-configured', 0, 0, 'not configured'],
  ['down', true, true, 'ok', 'outage', 'cap-reached', 0, 0, 'limit of 1,000 calls is used up'],
  ['down', true, 'corrupt', 'ok', 'outage', 'budget-unavailable', 0, 0, 'call counter'],
  ['down', true, false, 'ok', 'fallback', 'answered', 1, 10, undefined],
  ['down', true, false, 'empty', 'empty', 'no-results', 1, 0, undefined],
  ['down', true, false, 'error', 'outage', 'failed', 1, 0, 'HTTP 503'],
  ['down-results', true, false, 'ok', 'fallback', 'answered', 1, 10, undefined],
  [
    'down-results',
    true,
    false,
    'empty',
    'partial',
    'no-results',
    1,
    1,
    'Tavily (the fallback) found nothing.',
  ],
  // Other engines' results stay a success when the fallback cannot help.
  ['down-results', true, false, 'error', 'partial', 'failed', 1, 1, 'HTTP 503'],
]
it.each(table)(
  'search decision: %s, key=%s cap=%s Tavily=%s → %s',
  async (primary, key, cap, tavily, outcome, fallback, tavilyCalls, shown, cause) => {
    const userHome = await temp()
    homes.push(userHome)
    await mkdir(join(userHome, '.ultimate'))
    if (key === 'unreadable')
      await writeFile(join(userHome, '.ultimate/secrets.json'), 'invalid', { mode: 0o600 })
    else if (key) await writeSecret(userHome, 'TAVILY_API_KEY', 'test-key')
    if (cap === 'corrupt')
      await writeFile(join(userHome, '.ultimate/tavily-budget.sqlite'), 'invalid')
    if (cap === true) {
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
        if (url.endsWith('/config'))
          return Response.json({
            engines: [
              { name: 'yahoo', enabled: true, categories: ['general', 'web'] },
              { name: 'brave', enabled: true, categories: ['general', 'web'] },
              { name: 'example', enabled: true, categories: ['general'] },
              { name: 'github', enabled: true, categories: ['general', 'it'] },
            ],
          })
        if (!url.startsWith('https://api.tavily.com')) {
          const { engines, down } = primaries[primary]
          return Response.json({
            results: engines.map((engine) => ({ url: 'https://example.com', title: 'P', engine })),
            unresponsive_engines: down.map((engine) => [engine, 'timeout']),
          })
        }
        expect(url).toBe('https://api.tavily.com/search')
        expect(init?.redirect).toBe('error')
        expect(JSON.parse(init?.body as string)).toEqual({
          query: 'test',
          search_depth: 'basic',
          auto_parameters: false,
          max_results: 20,
        })
        calls++
        if (tavily === 'error') return new Response('', { status: 503 })
        return Response.json({
          results: Array.from({ length: tavily === 'ok' ? 20 : 0 }, (_, index) => ({
            url: `https://example.org/${index}`,
            title: 'Fallback',
            content: 'result',
          })),
        })
      }),
    )
    const result = await webSearch(userHome, { query: 'test' })
    expect(result.details.outcome).toBe(outcome)
    expect(result.details.fallback ?? undefined).toBe(fallback)
    expect(Boolean(result.isError)).toBe(outcome === 'outage')
    expect(calls).toBe(tavilyCalls)
    expect(result.details.results?.length ?? 0).toBe(shown)
    expect(result.text.includes('Results from Tavily (fallback 1/1,000 this month)')).toBe(
      outcome === 'fallback',
    )
    expect(result.text.includes('may be a real empty result')).toBe(outcome === 'unknown-empty')
    expect(result.text.startsWith('Web search is down: every SearXNG web engine failed')).toBe(
      outcome === 'outage',
    )
    expect(result.text).toContain(cause ?? '')
  },
)

it('returns at most 20 fallback results and says so when more were asked for', async () => {
  const userHome = await temp()
  homes.push(userHome)
  await writeSecret(userHome, 'TAVILY_API_KEY', 'test-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) =>
      String(input).startsWith('https://api.tavily.com/')
        ? Response.json({
            results: Array.from({ length: 20 }, (_, index) => ({
              url: `https://example.org/${index}`,
              title: 'Fallback',
            })),
          })
        : Response.json({ results: [], unresponsive_engines: [] }),
    ),
  )
  const fifteen = await webSearch(userHome, { query: 'test', count: 15 })
  expect(fifteen.details.results).toHaveLength(15)
  expect(fifteen.text).not.toContain('Tavily returns at most 20 results.')
  const many = await webSearch(userHome, { query: 'test', count: 25 })
  expect(many.details.results).toHaveLength(20)
  expect(many.text).toContain('Tavily returns at most 20 results.')
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
  expect((await webSearch(parent, { query: 'test' })).details.outcome).toBe('fallback')
  const env = previewEnv(
    {},
    { home: root, project: root, userHome: preview, parentUserHome: parent, ownerPid: 1 },
  )
  vi.stubEnv('ULTIMATE_WEB_SEARCH_STATE_HOME', env.ULTIMATE_WEB_SEARCH_STATE_HOME)
  expect((await webSearch(preview, { query: 'test' })).details.outcome).toBe('fallback')
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
  await writeSecret(userHome, 'TAVILY_API_KEY', 'test-key')
  const controller = new AbortController()
  const fetch = vi.fn<() => Promise<Response>>(async () => {
    controller.abort()
    return Response.json({ results: [], unresponsive_engines: [] })
  })
  vi.stubGlobal('fetch', fetch)
  const result = await webSearch(userHome, { query: 'test' }, controller.signal)
  expect(result.isError).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(result.details.outcome).toBe('cancelled')
})
