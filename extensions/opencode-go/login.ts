import { setTimeout as sleep } from 'node:timers/promises'
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'

/**
 * Sign in to OpenCode in the browser: the Console's device flow, as the OpenCode CLI does it (its public client id),
 * then the workspace whose Go subscription the requests use. Requests keep the caller's own identity; only the
 * bearer token and the workspace header come from here.
 */

const CONSOLE = 'https://opencode.ai/console'
const CLIENT_ID = 'opencode-cli'
/** Refresh this long before the access token expires. */
const EARLY_MS = 5 * 60_000

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  org_id?: string
  error?: string
}
type Workspace = { id: string; name: string }

async function post<T>(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${CONSOLE}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
    signal,
  })
  // The token endpoint answers pending and denied polls with 400 and an `error` field.
  const value = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok && !value.error) throw new Error(`OpenCode ${path} failed (${response.status})`)
  return value
}

async function workspaces(access: string, signal: AbortSignal): Promise<Workspace[]> {
  const response = await fetch(`${CONSOLE}/api/orgs`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${access}` },
    signal,
  })
  if (!response.ok) throw new Error(`OpenCode workspaces could not be read (${response.status})`)
  return (await response.json()) as Workspace[]
}

/** The workspace the Console scoped the grant to, the only one there is, or the one the user picks by name. */
async function pickWorkspace(
  access: string,
  granted: string | undefined,
  interaction: ProviderAuthInteraction,
) {
  const list = await workspaces(access, interaction.signal)
  if (granted && list.some((org) => org.id === granted)) return granted
  if (list.length === 1) return list[0].id
  if (list.length === 0) throw new Error('This OpenCode account has no workspace')
  // Options are indexes, so no workspace id reaches the login document or the dialog.
  const index = await interaction.prompt({
    type: 'select',
    message: 'Which workspace has your Go subscription?',
    options: list.map((org, i) => ({ id: String(i), label: org.name || `Workspace ${i + 1}` })),
  })
  const picked = list[Number(index)]
  if (!picked) throw new Error('No OpenCode workspace was picked')
  return picked.id
}

const tokens = (value: TokenResponse) => ({
  access: value.access_token!,
  expires: Date.now() + (value.expires_in ?? 3600) * 1000 - EARLY_MS,
})

export const opencodeLogin: OAuthAuth = {
  name: 'OpenCode Go',
  loginLabel: 'Sign in with OpenCode',
  isSubscription: true,
  async login(interaction) {
    const start = await post<{
      device_code?: string
      user_code?: string
      verification_uri?: string
      verification_uri_complete?: string
      interval?: number
      expires_in?: number
    }>('/auth/device/code', { supports_org_scope: true }, interaction.signal)
    const verification = start.verification_uri_complete ?? start.verification_uri
    if (!start.device_code || !start.user_code || !verification)
      throw new Error('OpenCode returned no device code')
    interaction.notify({
      type: 'device_code',
      userCode: start.user_code,
      verificationUri: new URL(verification, `${CONSOLE}/`).href,
      intervalSeconds: start.interval,
      expiresInSeconds: start.expires_in,
    })
    let interval = (start.interval ?? 5) * 1000
    const deadline = Date.now() + (start.expires_in ?? 600) * 1000
    while (Date.now() < deadline) {
      await sleep(Math.min(interval, deadline - Date.now()), undefined, {
        signal: interaction.signal,
      })
      if (Date.now() >= deadline) break
      const value = await post<TokenResponse>(
        '/auth/device/token',
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: start.device_code,
        },
        interaction.signal,
      )
      if (value.error === 'authorization_pending') continue
      if (value.error === 'slow_down') {
        interval += 5000
        continue
      }
      if (value.error === 'access_denied') throw new Error('The OpenCode sign-in was denied')
      if (value.error) throw new Error(`OpenCode sign-in failed: ${value.error}`)
      if (!value.access_token || !value.refresh_token) throw new Error('OpenCode returned no token')
      interaction.notify({ type: 'progress', message: 'Approved. Reading your workspaces…' })
      const orgId = await pickWorkspace(value.access_token, value.org_id, interaction)
      return { type: 'oauth', ...tokens(value), refresh: value.refresh_token, orgId }
    }
    throw new Error('The OpenCode device code expired; sign in again')
  },
  async refresh(credential, signal) {
    const value = await post<TokenResponse>(
      '/auth/device/token',
      { grant_type: 'refresh_token', refresh_token: credential.refresh },
      signal,
    )
    if (!value.access_token)
      throw new Error(`OpenCode token refresh failed: ${value.error ?? 'no token'}`)
    return {
      type: 'oauth',
      ...tokens(value),
      refresh: value.refresh_token ?? credential.refresh,
      orgId: credential.orgId,
    } satisfies OAuthCredential
  },
  async toAuth(credential) {
    return { apiKey: credential.access, headers: { 'x-opencode-org-id': String(credential.orgId) } }
  },
}
