/**
 * Quota: each subscription login's usage limits, read from the provider's own usage endpoint when someone looks and
 * the numbers are old, and sooner after that provider answered. Nothing runs while nobody asks.
 */
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { LoginChanged, Resets } from '../models/api.ts'
import { limited } from '../../lib/rate-limit.ts'
import { QuotaApi } from './api.ts'
import type { QuotaSource } from './api.ts'
import { builtinSources } from './sources.ts'
import { cacheStep, due } from './state.ts'
import type { Cached } from './state.ts'
import { StateAction } from './refs.ts'
import type { QuotaState } from './refs.ts'

const TIMEOUT = 15_000

/** The sources other extensions registered, which replace a built-in one of the same provider, and the readings. */
type Quota = { registered: Map<string, QuotaSource>; cache: Map<string, Cached> }

/** Kept across reloads, so a provider extension's source and the numbers survive one. */
const quota = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource<Quota>('quota', () => ({ registered: new Map(), cache: new Map() }))

const sourcesOf = (current: Quota) => [
  ...builtinSources.filter((source) => !current.registered.has(source.provider)),
  ...current.registered.values(),
]

const cached = (current: Quota, provider: string) => {
  let entry = current.cache.get(provider)
  if (!entry) current.cache.set(provider, (entry = {}))
  return entry
}

/**
 * What the popover says about a failed read, always a fixed phrase: any other message, even a source's own, could
 * quote a response or a token, and the action's result is shown and traced.
 */
function failure(error: unknown) {
  if (!(error instanceof Error)) return 'request failed'
  if (error.name === 'TimeoutError') return 'timed out'
  if (error.name === 'TypeError') return 'network error'
  return /^HTTP \d{3}$/.test(error.message) ? error.message : 'unexpected response'
}

async function read(host: Pick<ExtensionHost, 'modelRuntime'>, source: QuotaSource, entry: Cached) {
  const signal = AbortSignal.timeout(TIMEOUT)
  let apiKey: string | undefined
  try {
    apiKey = (await host.modelRuntime.getAuth(source.provider, { signal }))?.auth.apiKey
  } catch {
    // Pi's refresh error can quote the provider's answer; the login's own health is reported by health.
    cacheStep(entry, { type: 'fail', error: 'login could not be refreshed' })
    return
  }
  if (!apiKey) {
    cacheStep(entry, { type: 'fail', error: 'no login' })
    return
  }
  try {
    const reading = await source.read(apiKey, signal)
    cacheStep(entry, { type: 'read', reading, at: Date.now() })
  } catch (error) {
    cacheStep(entry, { type: 'fail', error: failure(error) })
  }
}

/** The subscription logins with a source, each read again first when its numbers are due. */
async function state(host: ExtensionHost, fresh: boolean): Promise<QuotaState> {
  const current = quota(host)
  const sources = sourcesOf(current).filter(
    (source) =>
      host.modelRuntime.getProviderAuthStatus(source.provider).configured &&
      host.modelRuntime.isUsingSubscription(source.provider),
  )
  const now = Date.now()
  await Promise.all(
    sources.flatMap((source) => {
      const entry = cached(current, source.provider)
      if (!entry.inflight && due(entry, now, fresh)) {
        const reading = read(host, source, entry).finally(() =>
          cacheStep(entry, { type: 'settle' }),
        )
        cacheStep(entry, { type: 'start', at: now, reading })
      }
      return entry.inflight ? [entry.inflight] : []
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
  host.implement(QuotaApi, {
    register(source) {
      current.registered.set(source.provider, source)
      return () => {
        if (current.registered.get(source.provider) === source)
          current.registered.delete(source.provider)
      }
    },
  })
  host.implement(Resets, {
    // Asked after a limit error that went around `afterResponse`: read again, a reading from before it may show room.
    // The limit is lifted once every exhausted window has reset.
    async resetsAt(provider) {
      cacheStep(cached(current, provider), { type: 'answer', at: Date.now(), limited: true })
      const reading = (await state(host, false)).providers.find(
        (item) => item.provider === provider,
      )
      const resets = (reading?.windows ?? []).flatMap((window) =>
        window.used >= 100 && window.resetsAt !== undefined ? [window.resetsAt] : [],
      )
      return resets.length ? Math.max(...resets) : undefined
    },
  })
  // Another account's numbers must not show under the new login: drop them, the next look reads again.
  host.react('login-changed', [LoginChanged], (_tx, { data }) => {
    current.cache.delete(data.provider)
  })
  return defineExtension({
    name: 'quota',
    hooks: [
      hook(GenerationTask, {
        // An answer used some of the limits: the next look reads them sooner, and at once after a limit error.
        afterResponse(message) {
          const covered = sourcesOf(current).some((source) => source.provider === message.provider)
          if (!covered || message.stopReason === 'aborted') return
          const entry = cached(current, message.provider)
          cacheStep(entry, {
            type: 'answer',
            at: Date.now(),
            limited: message.stopReason === 'error' && limited(message.errorMessage ?? ''),
          })
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
