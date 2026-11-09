/** Live tasks by kind: each extension reads its own with it, such as the work it reports to `underway`. */
import type { ConversationId, Tx } from '@earendil-works/pi-durable'

/** Every task state but `terminal`: queried by status, so finished tasks are never scanned. */
const LIVE = ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const

/** Live tasks of `kind` in `conversationId` (any conversation when undefined). */
export async function liveTasks(tx: Tx, kind: string, conversationId?: ConversationId) {
  const found = []
  for (const status of LIVE) {
    let cursor: Parameters<Tx['scanTasks']>[2]
    do {
      const page = await tx.scanTasks(
        { ...(conversationId === undefined ? {} : { conversationId }), kind, status },
        100,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }
  return found
}
