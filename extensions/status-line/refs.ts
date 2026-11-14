/** The status line in the browser: token rates and spend across every conversation of this host. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Tokens by kind. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
/**
 * Tokens per second over the last 30 seconds at most, measured over `elapsed` seconds, and the totals since the server
 * opened with their cost in dollars.
 */
export type RateSample = { rates: Tokens; elapsed: number; totals: Tokens & { cost: number } }

/** No arguments → the latest rate sample, or null until two samples within 5 seconds of each other exist. */
export const RatesAction = actionRef<null, RateSample | null>('status-line', 'rates', {
  global: true,
})

/**
 * What one model used, with its cost in dollars at the model's API price (0 when it has none): `cost` in all, `costs`
 * per token kind.
 */
export type Spend = Tokens & { cost: number; costs: Tokens }
/**
 * One conversation's own spend per `provider/model`, tools that report usage under `tools/<name>`; `owner` is the
 * conversation that owns it, absent for the tree's top.
 */
export type OwnSpend = { owner?: number; models: Record<string, Spend> }
/**
 * What a top-level conversation and everything it owns (its subagents and theirs) used: each conversation of the tree
 * by id, also those that have not spent anything yet.
 */
export type TreeSpend = { agents: Record<string, OwnSpend> }

/**
 * No arguments → each top-level conversation's tree spend that has any, by conversation id; null until the server has
 * read every conversation's usage.
 */
export const TreesAction = actionRef<null, Record<string, TreeSpend> | null>(
  'status-line',
  'trees',
  {
    global: true,
  },
)
