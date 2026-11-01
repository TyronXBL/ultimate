import type { UsageState } from '@earendil-works/pi-durable'
import type { Spend, TreeSpend } from './refs.ts'

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

/** No spend yet. */
export const empty = (): Spend => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })

/** Add `spend` into `sum`. */
export function add(sum: Spend, spend: Spend) {
  sum.input += spend.input
  sum.output += spend.output
  sum.cacheRead += spend.cacheRead
  sum.cacheWrite += spend.cacheWrite
  sum.cost += spend.cost
}

/**
 * Each top-level conversation's spend with everything it owns, at any depth, from every conversation's owner and
 * `pi.usage`. A fork starts its `pi.usage` empty, so a branch never counts its root's spend.
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
  for (const id of owners.keys()) {
    const tree = (trees[topOf(id)] ??= { conversations: 0, models: {} })
    tree.conversations++
    const usage = usages.get(id)
    if (!usage) continue
    const buckets = [
      ...Object.entries(usage.models),
      ...Object.entries(usage.tools).map(([name, bucket]) => [`tools/${name}`, bucket] as const),
    ]
    // Every key has a `/`, so none is an inherited property such as `__proto__`.
    for (const [key, bucket] of buckets)
      add((tree.models[key] ??= empty()), { ...bucket, cost: bucket.cost.total })
  }
  for (const [id, tree] of Object.entries(trees))
    if (Object.keys(tree.models).length === 0) delete trees[id]
  return trees
}
