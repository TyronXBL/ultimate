/** The status-line chip's look. Browser-safe. */
import type { QuotaProvider, QuotaWindow } from './refs.ts'

/** From this share on a limit is close; at 100 its pool is blocked until it resets. */
export const NEAR = 70

/**
 * The status-line chip's look, in one place: `full` when a limit is used up (amber "N full"), `near` from `NEAR` up,
 * else `ok`. Never red: a used-up pool may be one the user never runs, so red stays in the popover. `failed` (a read
 * failed) only shows on the icon while the chip is `ok`. `top` is the fullest limit across every login.
 */
export function chipOf(providers: QuotaProvider[]) {
  let top: { provider: QuotaProvider; window: QuotaWindow } | undefined
  let full = 0
  for (const provider of providers)
    for (const window of provider.windows) {
      if (window.used >= 100) full++
      if (!top || window.used > top.window.used) top = { provider, window }
    }
  const look: 'full' | 'near' | 'ok' = full
    ? 'full'
    : (top?.window.used ?? 0) >= NEAR
      ? 'near'
      : 'ok'
  return { look, full, top, failed: providers.some((provider) => provider.error) }
}
