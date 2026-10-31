/**
 * Quota: each subscription login's usage limits, read from the provider's own usage endpoint when someone looks and
 * the numbers are old, and sooner after that provider answered. Nothing runs while nobody asks.
 */
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { limited } from '../../lib/rate-limit.ts'
import { QuotaApi } from './api.ts'
import type { QuotaReading, QuotaSource } from './api.ts'
import { builtinSources } from './sources.ts'
import { StateAction } from './refs.ts'
import type { QuotaState } from './refs.ts'

const MINUTE = 60_000
/** How old numbers may get while the provider is idle; after one of its answers; when the user asks for fresh ones. */
const IDLE = 5 * MINUTE
const USED = MINUTE
const FRESH = 30_000
const TIMEOUT = 15_000

/** One provider's last reading, the last attempt, and its latest answer, which shortens how long the reading holds. */
type Cached = {
  reading?: QuotaReading & { at: number }
  tried?: number
  error?: string
  used?: number
  /** A limit error after the last attempt: read again at once. */
  limitedAt?: number
  inflight?: Promise<void>
}

type Quota = { sources: Map<string, QuotaSource>; cache: Map<string, Cached> }

/** The sources and readings, kept across reloads, so a provider extension's source and the numbers survive one. */
const quota = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource<Quota>('quota', () => ({ sources: new Map(), cache: new Map() }))

const cached = (state: Quota, provider: string) => {
  let entry = state.cache.get(provider)
  if (!entry) state.cache.set(provider, (entry = {}))
  return entry
}

/** Whether `entry` should be read again at `now`: never read, a limit hit since, or older than its allowance. */
export function due(entry: Cached, now: number, fresh: boolean) {
  if (entry.tried === undefined) return true
  if (entry.limitedAt !== undefined && entry.limitedAt > entry.tried) return true
  const allowance = fresh
    ? FRESH
    : entry.used !== undefined && entry.used > entry.tried
      ? USED
      : IDLE
  return now - entry.tried >= allowance
}

/**
 * What the popover says about a failed read. Only a source's own plain `Error` keeps its message: a token refresh,
 * JSON or decoding error can quote a response or a token, so those become a fixed phrase.
 */
function failure(error: unknown) {
  if (!(error instanceof Error)) return 'request failed'
  if (error.name === 'TimeoutError') return 'timed out'
  if (error.name === 'TypeError') return 'network error'
  return error.constructor === Error ? error.message : 'unexpected response'
}

async function read(host: Pick<ExtensionHost, 'modelRuntime'>, source: QuotaSource, entry: Cached) {
  entry.tried = Date.now()
  const signal = AbortSignal.timeout(TIMEOUT)
  let apiKey: string | undefined
  try {
    apiKey = (await host.modelRuntime.getAuth(source.provider, { signal }))?.auth.apiKey
  } catch {
    // Pi's refresh error can quote the provider's answer; the login's own health is reported by health.
    entry.error = 'login could not be refreshed'
    return
  }
  try {
    if (!apiKey) throw new Error('no login')
    const reading = await source.read(apiKey, signal)
    entry.reading = { ...reading, at: Date.now() }
    delete entry.error
  } catch (error) {
    entry.error = failure(error)
  }
}

/** The subscription logins with a source, each read again first when its numbers are due. */
async function state(host: ExtensionHost, fresh: boolean): Promise<QuotaState> {
  const current = quota(host)
  const sources = [...current.sources.values()].filter(
    (source) =>
      host.modelRuntime.getProviderAuthStatus(source.provider).configured &&
      host.modelRuntime.isUsingSubscription(source.provider),
  )
  const now = Date.now()
  await Promise.all(
    sources.map((source) => {
      const entry = cached(current, source.provider)
      if (!entry.inflight && due(entry, now, fresh))
        entry.inflight = read(host, source, entry).finally(() => delete entry.inflight)
      return entry.inflight
    }),
  )
  return {
    providers: sources.map(({ provider, name }) => {
      const { reading, error } = cached(current, provider)
      return {
        provider,
        name,
        windows: [],
        ...reading,
        ...(error ? { error } : {}),
      }
    }),
  }
}

export default function quotaExtension(host: ExtensionHost) {
  const current = quota(host)
  for (const source of builtinSources) current.sources.set(source.provider, source)
  host.implement(QuotaApi, {
    register(source) {
      current.sources.set(source.provider, source)
      return () => {
        if (current.sources.get(source.provider) === source) current.sources.delete(source.provider)
      }
    },
  })
  return defineExtension({
    name: 'quota',
    hooks: [
      hook(GenerationTask, {
        // An answer used some of the limits: the next look reads them sooner, and at once after a limit error.
        afterResponse(message) {
          if (!current.sources.has(message.provider) || message.stopReason === 'aborted') return
          const entry = cached(current, message.provider)
          const now = Date.now()
          entry.used = now
          if (message.stopReason === 'error' && limited(message.errorMessage ?? ''))
            entry.limitedAt = now
        },
      }),
    ],
  })
}

export const actions = {
  state: implementAction(StateAction, (args, { host }) =>
    state(host, (args as { fresh?: unknown } | null)?.fresh === true),
  ),
}

/** The status-line chip asks every minute. */
export const pollActions = ['state']
