/**
 * Live tasks by kind, and whether a conversation waits on a job of its own. Jobs are matched by task kind, so callers
 * need neither the background nor the CI extension.
 */
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

/**
 * Jobs that deliver their result to the conversation that started them as input: a `background` command and a `ci`
 * run. Each submits its result in its `deliver` phase before it ends, so from then on the result counts (as input or a
 * run), not the job.
 */
const JOBS = ['background.run', 'ci.run']

/** Whether `id` waits on a background command or CI run of its own, which will wake it with its result. */
export async function awaitsJob(tx: Tx, id: ConversationId): Promise<boolean> {
  for (const kind of JOBS)
    for (const task of await liveTasks(tx, kind, id))
      if ((task.state as { checkpoint?: { phase?: string } }).checkpoint?.phase !== 'deliver')
        return true
  return false
}

/** Live waking `notify` tasks of `id`, which wake it when another conversation finishes. */
const wakingNotifies = async (tx: Tx, id: ConversationId) =>
  (await liveTasks(tx, 'lineage.notify', id)).filter(
    (task) => (task.input as { wake?: unknown }).wake !== false,
  )

/** Whether `id` waits on a `notify` that will wake it when another conversation finishes. */
export async function awaitsNotify(tx: Tx, id: ConversationId): Promise<boolean> {
  return (await wakingNotifies(tx, id)).length > 0
}

/**
 * Whether `id` still waits for a result of its own to be submitted: a job, or a waking `notify` before its `deliver`
 * phase. Once a result is submitted, the run it wakes may already be answering, and that answer is no longer interim.
 */
export async function awaitsResult(tx: Tx, id: ConversationId): Promise<boolean> {
  if (await awaitsJob(tx, id)) return true
  return (await wakingNotifies(tx, id)).some(
    (task) => (task.state as { checkpoint?: { phase?: string } }).checkpoint?.phase !== 'deliver',
  )
}
