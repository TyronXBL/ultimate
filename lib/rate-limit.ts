import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'

/**
 * Whether a model error is a provider's per-user cap on concurrent requests ("Concurrency limit exceeded for user,
 * please retry later", bare or inside a 429 body). It frees itself as the user's other runs end, so it is retried: it
 * neither pauses Ultimate nor switches to a backup model.
 */
export const concurrencyCapped = (error: string) => /concurrency limit exceeded/i.test(error)

/**
 * Whether a model error is a rate limit Pi retries: HTTP 429, "rate limit", "too many requests". Retrying sooner only
 * hits the limit again, so Ultimate pauses until the user presses Play, and the held run continues through Pi's retry.
 * Quota, usage-limit and billing errors are on Pi's no-retry list: they end the run at once and fail as usual.
 * Overloaded servers (529) are the provider's capacity, not the account's limit.
 */
export const rateLimited = (error: string) =>
  /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i.test(error) &&
  !concurrencyCapped(error) &&
  isRetryableAssistantError({ stopReason: 'error', errorMessage: error } as AssistantMessage)

/**
 * What a model error found no room in: the account's quota, the provider's capacity, or its rate limit. Which of them
 * says whether to wait or to run somewhere else, and a card's wording.
 */
export type Limit = 'quota' | 'capacity' | 'rate limit'

// Pi's no-retry list: `insufficient_quota`, `out of budget`, `quota exceeded`, `billing`, the OpenCode and ChatGPT
// subscription limits (`usage_limit`), plus the wording gateways use for an exhausted key or balance.
const quotaError =
  /insufficient_quota|out of budget|quota exceeded|billing|usage.?limit|usage.?credits|credits_required/i
// Pi's retryable list: an overloaded server (529), a busy model, a gRPC `ResourceExhausted`.
const capacityError =
  /overloaded|server_busy|at capacity|high demand|resources?exhausted|(?<![a-z0-9])529(?![a-z0-9])/i

/**
 * The limit `error` reports, or undefined for anything else: an auth failure, a network error, a context overflow. A
 * quota error is checked first, so a 429 that is really an exhausted balance reads as the quota, not the rate.
 */
export function limitOf(error: string): Limit | undefined {
  if (quotaError.test(error)) return 'quota'
  if (capacityError.test(error)) return 'capacity'
  return rateLimited(error) ? 'rate limit' : undefined
}

/**
 * Whether a model error is about the account or the provider having no room for the request right now: a rate limit,
 * a capacity, or an exhausted quota. A conversation on a backup model switches on the first of them.
 */
export const limited = (error: string) => limitOf(error) !== undefined
