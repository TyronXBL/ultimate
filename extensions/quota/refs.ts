/**
 * Quota in the browser: how much of each subscription login's usage limits is used, and when each limit resets.
 * Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** One usage limit of a subscription, as its provider reports it. */
export type QuotaWindow = {
  /** What it limits, as the user knows it: "5-hour", "Weekly", "Weekly · Opus". */
  label: string
  /** The pool it belongs to, for providers with several (Antigravity's "Gemini models"); unset for one pool. */
  group?: string
  /** Share of the limit used, 0–100, from the provider; never estimated. */
  used: number
  /** When it resets (ms), when the provider says. */
  resetsAt?: number
}

/** One subscription login and its limits. */
export type QuotaProvider = {
  /** Pi's provider id: `anthropic`, `openai-codex`, `antigravity`. */
  provider: string
  /** Its name in the UI: "Claude", "OpenAI Codex". */
  name: string
  /** The plan, when the provider says: "plus", "max". */
  plan?: string
  /** The limits from the last successful read, in the provider's order; empty before the first. */
  windows: QuotaWindow[]
  /** When `windows` were read (ms); unset before the first successful read. */
  at?: number
  /** Why the last read failed ("HTTP 401", "network error"); `windows` then are from the read before, if any. */
  error?: string
}

export type QuotaState = { providers: QuotaProvider[] }

/**
 * `{ fresh? }` → the subscription logins on this machine with their limits. Numbers older than a few minutes (one
 * after a response from that provider) are read again first; `fresh` reads anything older than 30 seconds.
 */
export const StateAction = actionRef<{ fresh?: boolean }, QuotaState>('quota', 'state')
