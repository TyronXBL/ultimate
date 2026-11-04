/** How many items a loop that starts git or other processes per item works on at once, on a small machine. */
export const PROCESS_CONCURRENCY = 4

/**
 * `items` mapped through `fn` with at most `limit` calls running at once, results in input order. Rejects with the
 * first failure, as `Promise.all` does; calls already started still finish, and no new ones start.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  let failed = false
  const run = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
