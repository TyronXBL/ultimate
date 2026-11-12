import type { UsageState } from '@earendil-works/pi-durable'
import type { Spend, Tokens, TreeSpend } from './refs.ts'

/** A conversation's own spend: every model and tool bucket of its `pi.usage`, added up. */
export function usageTotals(usage: Readonly<UsageState>) {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce(
    (sum, bucket) => ({
      input: sum.input + bucket.input,
      output: sum.output + bucket.output,
      cacheRead: sum.cacheRead + bucket.cacheRead,
      cacheWrite: sum.cacheWrite + bucket.cacheWrite,
      cost: sum.cost + bucket.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
}

const kinds = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
const pick = (value: Tokens): Tokens => ({
  input: value.input,
  output: value.output,
  cacheRead: value.cacheRead,
  cacheWrite: value.cacheWrite,
})
const none = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** No spend yet. */
export const empty = (): Spend => ({ ...none(), cost: 0, costs: none() })

/** Add `spend` into `sum`. */
export function add(sum: Spend, spend: Spend) {
  for (const kind of kinds) {
    sum[kind] += spend[kind]
    sum.costs[kind] += spend.costs[kind]
  }
  sum.cost += spend.cost
}

/**
 * Each top-level conversation's tree, every conversation it owns at any depth with its own spend, from every
 * conversation's owner and `pi.usage`; a tree that spent nothing is left out. A fork starts its `pi.usage` empty, so a
 * branch never counts its root's spend.
 */
export function treeSpend(
  owners: ReadonlyMap<number, number | undefined>,
  usages: ReadonlyMap<number, Readonly<UsageState>>,
) {
  const tops = new Map<number, number>()
  const topOf = (id: number): number => {
    const known = tops.get(id)
    if (known !== undefined) return known
    const owner = owners.get(id)
    const top = owner === undefined ? id : topOf(owner)
    tops.set(id, top)
    return top
  }
  const trees: Record<string, TreeSpend> = {}
  const spent = new Set<string>()
  for (const [id, owner] of owners) {
    const top = String(topOf(id))
    const models: Record<string, Spend> = {}
    ;(trees[top] ??= { agents: {} }).agents[id] =
      owner === undefined ? { models } : { owner, models }
    const usage = usages.get(id)
    if (!usage) continue
    const buckets = [
      ...Object.entries(usage.models),
      ...Object.entries(usage.tools).map(([name, bucket]) => [`tools/${name}`, bucket] as const),
    ]
    // Every key has a `/`, so none is an inherited property such as `__proto__`.
    for (const [key, bucket] of buckets) {
      models[key] = { ...pick(bucket), cost: bucket.cost.total, costs: pick(bucket.cost) }
      spent.add(top)
    }
  }
  for (const id of Object.keys(trees)) if (!spent.has(id)) delete trees[id]
  return trees
}
