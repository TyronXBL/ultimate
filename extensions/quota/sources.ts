/**
 * The built-in quota sources: the usage endpoints Claude Code's `/usage` and Codex's `/status` read, with the login's
 * own token. Each read returns the provider's own numbers; nothing is estimated.
 */
import type { QuotaReading, QuotaSource } from './api.ts'
import type { QuotaWindow } from './refs.ts'

/** GET `url` as JSON; a failure says only its HTTP status, never the body, which may echo the request. */
async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal) {
  const response = await fetch(url, { headers, signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as unknown
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const time = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : undefined
}

const ANTHROPIC_KINDS: Record<string, string> = { session: '5-hour', weekly_all: 'Weekly' }

/**
 * Claude's limits from `/api/oauth/usage`: its `limits` list, each `{ kind, percent, resets_at, scope }`. A weekly
 * limit scoped to one model is labelled with the model's name.
 */
export function anthropicReading(body: unknown): QuotaReading {
  const limits = record(body).limits
  if (!Array.isArray(limits)) throw new Error('unexpected response')
  const windows = limits.flatMap((entry): QuotaWindow[] => {
    const { kind, percent, resets_at: resetsAt, scope } = record(entry)
    if (typeof kind !== 'string' || typeof percent !== 'number') return []
    const model = record(record(scope).model).display_name
    const label =
      ANTHROPIC_KINDS[kind] ??
      (kind === 'weekly_scoped' && typeof model === 'string'
        ? `Weekly · ${model}`
        : kind.replaceAll('_', ' '))
    const at = time(resetsAt)
    return [{ label, used: percent, ...(at === undefined ? {} : { resetsAt: at }) }]
  })
  return { windows }
}

const windowLabel = (seconds: number) =>
  seconds === 5 * 3600
    ? '5-hour'
    : seconds === 7 * 86400
      ? 'Weekly'
      : seconds % 86400 === 0
        ? `${seconds / 86400}-day`
        : `${Math.round(seconds / 3600)}-hour`

/** Codex's limits from `/backend-api/wham/usage`: `rate_limit`'s primary and secondary windows, and the plan. */
export function codexReading(body: unknown): QuotaReading {
  const { plan_type: plan, rate_limit: rateLimit } = record(body)
  const limit = record(rateLimit)
  const windows = [limit.primary_window, limit.secondary_window].flatMap((value): QuotaWindow[] => {
    const window = record(value)
    const { used_percent: used, limit_window_seconds: seconds, reset_at: resetAt } = window
    if (typeof used !== 'number' || typeof seconds !== 'number') return []
    return [
      {
        label: windowLabel(seconds),
        used,
        ...(typeof resetAt === 'number' ? { resetsAt: resetAt * 1000 } : {}),
      },
    ]
  })
  if (!windows.length) throw new Error('unexpected response')
  return { ...(typeof plan === 'string' ? { plan } : {}), windows }
}

/** The ChatGPT account a Codex token belongs to, from its JWT claims, as Pi's Codex provider sends it. */
function codexAccount(token: string) {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('unexpected token')
  const claims = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  const account = record(claims['https://api.openai.com/auth']).chatgpt_account_id
  if (typeof account !== 'string') throw new Error('unexpected token')
  return account
}

export const builtinSources: QuotaSource[] = [
  {
    provider: 'anthropic',
    name: 'Claude',
    read: async (token, signal) =>
      anthropicReading(
        await getJson(
          'https://api.anthropic.com/api/oauth/usage',
          { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
          signal,
        ),
      ),
  },
  {
    provider: 'openai-codex',
    name: 'OpenAI Codex',
    read: async (token, signal) =>
      codexReading(
        await getJson(
          'https://chatgpt.com/backend-api/wham/usage',
          {
            authorization: `Bearer ${token}`,
            'chatgpt-account-id': codexAccount(token),
            // Codex expects an originator on every request, as Pi's Codex provider sends it.
            originator: 'pi',
          },
          signal,
        ),
      ),
  },
]
