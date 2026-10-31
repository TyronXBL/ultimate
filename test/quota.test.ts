import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { GenerationHooks } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import quotaExtension, { actions } from '../extensions/quota/server.ts'
import { QuotaApi } from '../extensions/quota/api.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { apis } from './helpers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A hand-built host whose Pi auth has a subscription login for each provider of `keys`, resolving to its key. */
function quotaHost(keys: Record<string, string>) {
  const services = apis()
  const resources = new Map<string, unknown>()
  const host = {
    ...services,
    resource: <T>(name: string, init: () => T) => {
      if (!resources.has(name)) resources.set(name, init())
      return resources.get(name) as T
    },
    modelRuntime: {
      getProviderAuthStatus: (provider: string) => ({ configured: provider in keys }),
      isUsingSubscription: (provider: string) => provider in keys,
      getAuth: async (provider: string) => ({ auth: { apiKey: keys[provider] } }),
    },
  } as unknown as ExtensionHost
  const hooks = quotaExtension(host).hooks![0].handlers as GenerationHooks
  const state = () => actions.state(null, { host } as ActionContext)
  return { services, hooks, state }
}

const answer = (provider: string, errorMessage?: string) =>
  ({ provider, stopReason: errorMessage ? 'error' : 'stop', errorMessage }) as AssistantMessage

it("reads Claude's and Codex's limits from their usage endpoints with the login's token", async () => {
  // Trimmed from real responses of both endpoints.
  const claude = {
    five_hour: { utilization: 7 },
    limits: [
      { kind: 'session', percent: 7, resets_at: '2026-10-31T04:39:59.821612+00:00', scope: null },
      { kind: 'weekly_all', percent: 45, resets_at: '2026-11-03T09:59:59.821632+00:00' },
      { kind: 'weekly_scoped', percent: 0, scope: { model: { id: null, display_name: 'Opus' } } },
    ],
  }
  const codex = {
    email: 'user@example.com',
    plan_type: 'plus',
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1793422367 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1793775881 },
    },
  }
  // A Codex token is a JWT whose claims name the ChatGPT account.
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } }
  const token = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
  const headers = new Map<string, Record<string, string>>()
  vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
    headers.set(new URL(url).host, init.headers)
    return Response.json(url.includes('anthropic') ? claude : codex)
  })
  const { state } = quotaHost({ anthropic: 'claude-token', 'openai-codex': token })
  expect((await state()).providers).toEqual([
    {
      provider: 'anthropic',
      name: 'Claude',
      windows: [
        { label: '5-hour', used: 7, resetsAt: Date.parse('2026-10-31T04:39:59.821Z') },
        { label: 'Weekly', used: 45, resetsAt: Date.parse('2026-11-03T09:59:59.821Z') },
        { label: 'Weekly · Opus', used: 0 },
      ],
      at: expect.any(Number),
    },
    {
      provider: 'openai-codex',
      name: 'OpenAI Codex',
      plan: 'plus',
      windows: [
        { label: '5-hour', used: 10, resetsAt: 1793422367000 },
        { label: 'Weekly', used: 40, resetsAt: 1793775881000 },
      ],
      at: expect.any(Number),
    },
  ])
  expect(headers.get('api.anthropic.com')).toMatchObject({
    authorization: 'Bearer claude-token',
    'anthropic-beta': 'oauth-2025-04-20',
  })
  expect(headers.get('chatgpt.com')).toMatchObject({
    authorization: `Bearer ${token}`,
    'chatgpt-account-id': 'account-1',
  })
})

it('lists registered sources of subscription logins and reads them again only when due', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
  let reads = 0
  let fail: Error | undefined
  const { services, hooks, state } = quotaHost({ antigravity: 'antigravity-key' })
  services.need(QuotaApi).register({
    provider: 'antigravity',
    name: 'Antigravity',
    read: async (apiKey) => {
      expect(apiKey).toBe('antigravity-key')
      reads++
      if (fail) throw fail
      return { windows: [{ label: '5h', group: 'Gemini', used: reads * 10 }] }
    },
  })
  // Claude and Codex have no login in this host, so only the registered source is listed.
  expect(await state()).toEqual({
    providers: [
      {
        provider: 'antigravity',
        name: 'Antigravity',
        windows: [{ label: '5h', group: 'Gemini', used: 10 }],
        at: 0,
      },
    ],
  })
  // Within five idle minutes the reading holds; an answer from the provider shortens that to one minute.
  vi.setSystemTime(4 * 60_000)
  await state()
  expect(reads).toBe(1)
  await hooks.afterResponse(answer('antigravity'), {} as never, {} as never)
  vi.setSystemTime(5 * 60_000 - 1)
  await state()
  expect(reads).toBe(2)
  // A limit error reads again at once.
  vi.setSystemTime(5 * 60_000)
  await hooks.afterResponse(
    answer('antigravity', '429 Too Many Requests'),
    {} as never,
    {} as never,
  )
  fail = new SyntaxError('Unexpected token in JSON at "secret-body"')
  const failed = await state()
  expect(reads).toBe(3)
  // A failure keeps the last numbers and never quotes an error that could carry a response.
  expect(failed.providers[0]).toEqual({
    provider: 'antigravity',
    name: 'Antigravity',
    windows: [{ label: '5h', group: 'Gemini', used: 20 }],
    at: 5 * 60_000 - 1,
    error: 'unexpected response',
  })
})
