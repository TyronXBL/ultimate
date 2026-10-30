import { stripVTControlCharacters } from 'node:util'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { FailingTest, LanderEntry } from './types.ts'

/** Test names carried by Vitest's failure summary lines (or the legacy ci-gate format). */
export function failedTests(output: string): string[] {
  const tests = new Set<string>()
  for (const line of stripVTControlCharacters(output).split('\n')) {
    const match = /^\s*FAIL\s+(.+)$/.exec(line)
    if (!match) continue
    let name = match[1].trim().replace(/\s+\[\s*[^\]]+\s*\]$/, '')
    if (!name.includes(' > ')) name = name.split(': ', 1)[0].trim()
    if (/^[\w./@-]+\.[cm]?[jt]sx?( > |$)/.test(name)) tests.add(name)
  }
  return [...tests]
}

/** Derive repeat sightings from the immutable lander log; the caller supplies the lander conversations. */
export async function failingTestsFromLog(
  tx: Tx,
  conversations: number[],
  options: { tests?: string[]; except?: number; limit?: number } = {},
): Promise<FailingTest[]> {
  const wanted = options.tests ? new Set(options.tests) : undefined
  const submissions = new Map<
    string,
    {
      conversationId: number
      sourceEntry?: number
      at: number
      failed: Set<string>
      sank: Set<string>
    }
  >()
  for (const conversationId of conversations) {
    let cursor: Parameters<Tx['scanEntries']>[2]
    do {
      const page = await tx.scanEntries(
        { conversationId: conversationId as ConversationId, order: 'descending' },
        256,
        cursor,
      )
      for (const raw of page.items) {
        if (raw.kind !== 'ultimate.lander') continue
        const entry = raw.data as LanderEntry
        if (entry.conversationId === options.except) continue
        let row = submissions.get(entry.submission)
        if (!row) {
          row = {
            conversationId: entry.conversationId,
            ...(entry.sourceEntry ? { sourceEntry: entry.sourceEntry } : {}),
            at: entry.at,
            failed: new Set(),
            sank: new Set(),
          }
          submissions.set(entry.submission, row)
        }
        if (entry.check?.result === 'failed')
          for (const test of failedTests(entry.output ?? '')) row.failed.add(test)
        if (entry.outcome === 'failed')
          for (const test of failedTests(entry.output ?? '')) row.sank.add(test)
      }
      cursor = page.next
    } while (cursor)
  }
  const grouped = new Map<string, FailingTest>()
  for (const [submission, row] of submissions) {
    for (const test of row.failed) {
      if (wanted && !wanted.has(test)) continue
      const item = grouped.get(test) ?? { test, landings: [], branches: 0 }
      item.landings.push({
        submission,
        conversationId: row.conversationId,
        ...(row.sourceEntry ? { sourceEntry: row.sourceEntry } : {}),
        at: row.at,
        sank: row.sank.has(test),
      })
      grouped.set(test, item)
    }
  }
  const result = [...grouped.values()]
  for (const item of result)
    item.branches = new Set(item.landings.map((landing) => landing.conversationId)).size
  for (const item of result) item.landings.sort((a, b) => b.at - a.at)
  result.sort(
    (a, b) =>
      b.branches - a.branches ||
      b.landings.length - a.landings.length ||
      (b.landings[0]?.at ?? 0) - (a.landings[0]?.at ?? 0),
  )
  return result.slice(0, options.limit ?? result.length)
}
