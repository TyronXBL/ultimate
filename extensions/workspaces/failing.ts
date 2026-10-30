/**
 * Tests that keep failing at landing, derived on read from the lander log: no record of its own. Every failed check
 * run keeps its output in an `ultimate.lander` entry (the first run on its `checked` step, the rerun on the `failed`
 * outcome), and Vitest names each failed test on a `FAIL <file> > <test>` line.
 */
import { stripVTControlCharacters } from 'node:util'
import type { Context } from '@earendil-works/chord'
import type { ConversationId, Cursor, Harness } from '@earendil-works/pi-durable'
import type { FailingTest, LanderEntry } from './types.ts'

/**
 * The tests a check's output names on Vitest's `FAIL` lines, as `<file> > … > <test>` (a file alone when the file
 * failed). Lines that name no file, such as a failed CI job or an unhandled error, are left out.
 */
export function failedTests(output: string) {
  const tests = new Set<string>()
  for (const line of stripVTControlCharacters(output).split('\n')) {
    const match = /^\s*FAIL\s+(.+)$/.exec(line)
    if (!match) continue
    // Vitest marks a failed file `<file> [ <file> ]`; the CI gate once printed a failed file as `FAIL <file>: <message>`.
    let name = match[1].trim().replace(/\s+\[\s*[^\]]+\s*\]$/, '')
    if (!name.includes(' > ')) name = name.split(': ', 1)[0].trim()
    if (/^[\w./@-]+\.[cm]?[jt]sx?( > |$)/.test(name)) tests.add(name)
  }
  return [...tests]
}

/** How many of each lander conversation's newest log lines are read: months of landings, a bounded read. */
const RECENT = 5000

/**
 * The failed tests of the lander conversations' recent logs, most branches first: only `tests` when given, and without
 * the submissions of conversation `except`, so a branch never counts its own repeated failures. It reads outside any
 * transaction, so no commit waits for it.
 */
export async function failingTests(
  harness: Harness,
  conversations: number[],
  options: { tests?: string[]; except?: number; limit?: number },
  context: Context,
): Promise<FailingTest[]> {
  const wanted = options.tests && new Set(options.tests)
  const submissions = new Map<
    string,
    { entry: LanderEntry; failed: Set<string>; sank: Set<string> }
  >()
  for (const conversationId of conversations) {
    const log = await harness.conversation(conversationId as ConversationId, context)
    let cursor: Cursor | undefined
    let read = 0
    do {
      if (!log) break
      const page = await log.entries({}, 256, cursor, context)
      read += page.items.length
      for (const raw of page.items) {
        if (raw.kind !== 'ultimate.lander') continue
        const entry = raw.data as LanderEntry
        const failedRun = entry.check?.result === 'failed'
        if (entry.conversationId === options.except || !entry.output) continue
        if (!failedRun && entry.outcome !== 'failed') continue
        const row = submissions.get(entry.submission) ?? {
          entry,
          failed: new Set<string>(),
          sank: new Set<string>(),
        }
        submissions.set(entry.submission, row)
        for (const test of failedTests(entry.output)) {
          if (wanted && !wanted.has(test)) continue
          row.failed.add(test)
          if (!failedRun) row.sank.add(test)
        }
      }
      cursor = page.next
    } while (cursor && read < RECENT)
  }
  const grouped = new Map<string, FailingTest>()
  for (const [submission, { entry, failed, sank }] of submissions)
    for (const test of failed) {
      const item = grouped.get(test) ?? { test, landings: [], branches: [] }
      item.landings.push({
        submission,
        conversationId: entry.conversationId,
        ...(entry.sourceEntry === undefined ? {} : { sourceEntry: entry.sourceEntry }),
        at: entry.at,
        sank: sank.has(test),
      })
      grouped.set(test, item)
    }
  const result = [...grouped.values()]
  for (const item of result) {
    item.landings.sort((a, b) => b.at - a.at)
    item.branches = [...new Set(item.landings.map((landing) => landing.conversationId))]
  }
  result.sort(
    (a, b) =>
      b.branches.length - a.branches.length ||
      b.landings.length - a.landings.length ||
      b.landings[0].at - a.landings[0].at,
  )
  return result.slice(0, options.limit)
}
