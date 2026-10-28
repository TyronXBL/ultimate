import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import searxng from '../extensions/searxng/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

/** The tools over a temp user home whose settings point `searxng.url` at `url`. */
async function tools(url = 'http://127.0.0.1:1') {
  const userHome = await temp()
  cleanup.push(() => removeTemp(userHome))
  await mkdir(join(userHome, '.ultimate'))
  await writeFile(join(userHome, '.ultimate/settings.json'), JSON.stringify({ searxng: { url } }))
  const host = {
    userHome,
    notice: () => {},
    resource: <T>(_key: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => cleanup.push(close),
  } as unknown as ExtensionHost
  const [search, fetch] = searxng(host).tools!
  const run = async (tool: typeof search, args: unknown) => {
    const details = vi.fn<(value: unknown) => Promise<void>>(async () => {})
    const result = (await tool.execute(args, { details } as never, {} as never)) as {
      isError?: boolean
      output: { text: string }[]
    }
    return { ...result, text: result.output[0].text, details: details.mock.calls[0]?.[0] }
  }
  return {
    search: (args: unknown) => run(search, args),
    fetch: (args: unknown) => run(fetch, args),
  }
}

/** A local HTTP server; returns its base URL and the paths it was asked for. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return { base: `http://127.0.0.1:${address.port}`, requests }
}

it('web_search asks SearXNG for JSON and returns its results with unresponsive engines', async () => {
  const instance = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        results: [
          {
            url: 'https://www.example.com/a',
            title: 'A page',
            content: 'About A',
            engine: 'brave',
          },
          { title: 'no url' },
        ],
        unresponsive_engines: [['duckduckgo', 'CAPTCHA']],
      }),
    )
  })
  const result = await (await tools(instance.base)).search({ query: 'a b', time_range: 'week' })
  expect(instance.requests).toEqual(['/search?q=a+b&format=json&time_range=week'])
  expect(result.isError).toBeUndefined()
  expect(result.text).toContain('1. A page\nURL: https://www.example.com/a\nAbout A')
  expect(result.text).toContain('1 upstream engine was unresponsive (duckduckgo: CAPTCHA)')
  expect(result.details).toEqual({
    status: 'success',
    results: [
      {
        url: 'https://www.example.com/a',
        title: 'A page',
        snippet: 'About A',
        publishedDate: null,
        domain: 'example.com',
        engine: 'brave',
      },
    ],
    unresponsive: [{ engine: 'duckduckgo', message: 'CAPTCHA' }],
  })
})

it('web_fetch refuses loopback addresses by name and by IP without connecting', async () => {
  const local = await serve((_request, response) => response.end('<p>secret</p>'))
  const { fetch } = await tools()
  for (const url of [local.base, local.base.replace('127.0.0.1', 'localhost')]) {
    const result = await fetch({ url })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^web_fetch refuses (127\.0\.0\.1|localhost)\b/)
  }
  expect(local.requests).toEqual([])
})
