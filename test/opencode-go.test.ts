import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import opencodeGo from '../extensions/opencode-go/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

/** OpenCode's Console as the device flow sees it: one pending poll, then a grant without a workspace scope. */
function consoleServer() {
  const bodies: Record<string, unknown>[] = []
  let polls = 0
  // login.ts calls fetch with a URL string and, for posts, a JSON string body.
  const fetch = vi.fn<(url: string, init?: { body?: string }) => Promise<Response>>(
    async (url, init) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      bodies.push(body)
      if (url.endsWith('/auth/device/code'))
        return Response.json({
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri_complete: '/console/device?user_code=ABCD-EFGH',
          interval: 0,
          expires_in: 600,
        })
      if (url.endsWith('/auth/device/token'))
        return polls++ === 0
          ? Response.json({ error: 'authorization_pending' }, { status: 400 })
          : Response.json({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600,
            })
      if (url.endsWith('/api/orgs'))
        return Response.json([
          { id: 'org-team', name: 'Team' },
          { id: 'org-personal', name: 'Personal' },
        ])
      return new Response('not found', { status: 404 })
    },
  )
  vi.stubGlobal('fetch', fetch)
  return { bodies }
}

it('signs in to OpenCode Go with a device code, then sends the token and the picked workspace', async () => {
  const root = await temp()
  cleanup.push(root)
  const { bodies } = consoleServer()
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(root, 'auth.json') })
  const resources = new Map<string, unknown>()
  const closers: (() => Promise<void>)[] = []
  opencodeGo({
    modelRuntime: runtime,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    onClose: (close: () => Promise<void>) => closers.push(close),
  } as unknown as ExtensionHost)

  const go = runtime.getProvider('opencode-go')!
  expect(go.auth.apiKey).toBeDefined()
  expect(go.getModels().length).toBeGreaterThan(0)

  const events: AuthEvent[] = []
  const prompts: AuthPrompt[] = []
  await runtime.login('opencode-go', 'oauth', {
    notify: (event) => events.push(event),
    prompt: async (prompt) => {
      prompts.push(prompt)
      return '1'
    },
  })

  expect(events[0]).toMatchObject({
    type: 'device_code',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://opencode.ai/console/device?user_code=ABCD-EFGH',
  })
  expect(bodies[0]).toMatchObject({ client_id: 'opencode-cli', supports_org_scope: true })
  // Workspaces are offered by name; their ids never reach the prompt.
  expect(prompts).toEqual([
    expect.objectContaining({
      type: 'select',
      options: [
        { id: '0', label: 'Team' },
        { id: '1', label: 'Personal' },
      ],
    }),
  ])
  expect(runtime.isUsingSubscription('opencode-go')).toBe(true)
  expect((await runtime.getAuth('opencode-go'))?.auth).toEqual({
    apiKey: 'access-1',
    headers: { 'x-opencode-org-id': 'org-personal' },
  })

  // The last facet to close gives the provider back to Pi: API key only.
  for (const close of closers) await close()
  expect(runtime.getProvider('opencode-go')?.auth.oauth).toBeUndefined()
})
