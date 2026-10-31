/**
 * Quota: how much of each subscription login's usage limits is used, read from the provider's own usage endpoint.
 * Claude (Anthropic login) and OpenAI Codex are built in; a provider extension adds its own with `register`.
 */
import { defineApi } from '../../shared/extension-api.ts'
import type { QuotaWindow } from './refs.ts'

/** What one read of a provider's usage returns. */
export type QuotaReading = { plan?: string; windows: QuotaWindow[] }

/** How to read one provider's limits. */
export type QuotaSource = {
  /** Pi's provider id; the source is used while that provider has a subscription (OAuth) login here. */
  provider: string
  /** Its name in the UI. */
  name: string
  /**
   * Read the limits with `apiKey`, the request key Pi's auth resolves for the login (refreshed when due). Throw on
   * failure; the message is shown, so keep credentials and response bodies out of it.
   */
  read(apiKey: string, signal: AbortSignal): Promise<QuotaReading>
}

export type QuotaService = {
  /** Add or replace the source for `source.provider`; returns its removal, for the caller's `onClose`. */
  register(source: QuotaSource): () => void
}
/** Subscription limits; `want` it, quota is optional. */
export const QuotaApi = defineApi<QuotaService>()('quota')
