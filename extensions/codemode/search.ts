/**
 * `ultimate.search` over a chapter's stored entries, in a worker thread with its own read-only connection, so a scan of
 * the whole history never blocks the host (#199903: a full scan of a 145 MB chapter in JavaScript on the main thread
 * froze the host for 1.86 s). SQLite's `instr()` finds the matching rows; JavaScript only reads the hits.
 */
import type { ConversationRecord } from '@earendil-works/pi-durable'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

export type SearchOptions = {
  conversationId?: number
  limit?: number
  kinds?: string[]
  full?: boolean
}

/** What the worker gets: options already checked on the main thread, so their errors throw where they did. */
export type SearchRequest = {
  database: string
  text: string
  count: number
  conversationId?: number
  kinds?: string[]
  full?: boolean
}

/** Search `request.database` here, on the calling thread; `searchChapter` runs it in a worker. */
export function searchDatabase({
  database,
  text,
  count,
  conversationId,
  kinds,
  full,
}: SearchRequest) {
  // Pi upstream: @earendil-works/pi-durable@1.5.0 src/storage/sqlite/storage.ts writes each entry as
  // `JSON.stringify(entry)` into `entries.record`, so a substring of the stored text is a substring of the entry's JSON,
  // and the excerpt below is cut from the same string the JavaScript scan built. Fork chains follow `readEntries`.
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const records = new Map(
      db
        .prepare('SELECT id, record FROM conversations ORDER BY id')
        .all()
        .map((row) => [Number(row.id), JSON.parse(String(row.record)) as ConversationRecord]),
    )
    if (conversationId !== undefined && !records.has(conversationId))
      throw new Error('Unknown conversation')
    // One statement, and so one read transaction, per fork segment: a WAL checkpoint waits for at most one of them.
    // SQLite matches UTF-8, where half a surrogate pair is no substring; JavaScript's indexOf matches it in UTF-16, so
    // such text reads every row and the check below decides.
    const segment = db.prepare(
      `SELECT json_extract(record, '$.kind') AS kind, record FROM entries WHERE conversation_id = ? AND id <= ? AND ${text.isWellFormed() ? 'instr(record, ?) > 0' : '? IS NOT NULL'} ORDER BY id DESC`,
    )
    const matches: unknown[] = []
    for (const start of conversationId === undefined ? records.keys() : [conversationId]) {
      let record = records.get(start)!
      let upper = Number.MAX_SAFE_INTEGER
      while (true) {
        for (const row of segment.iterate(record.id, upper, text)) {
          const json = String(row.record)
          const at = json.indexOf(text)
          if (at < 0 || (kinds && !kinds.includes(String(row.kind)))) continue
          matches.push(hit(json, at, text.length, full))
          if (matches.length === count) return matches
        }
        if (!record.parent) break
        upper = Math.min(upper, record.parent.at)
        record = records.get(record.parent.conversationId)!
      }
    }
    return matches
  } finally {
    db.close()
  }
}

/**
 * What a search returns for an entry whose JSON has the match at `at`: the whole entry with `full`, otherwise
 * `{conversation, id, kind, at, excerpt}` with about 200 characters of its JSON around the match, so wide audits stay
 * small enough to return and to send across projects.
 */
function hit(json: string, at: number, length: number, full: boolean | undefined) {
  const entry = JSON.parse(json)
  if (full) return entry
  const start = Math.max(0, at - 80)
  const end = Math.min(json.length, at + length + 120)
  const time = entry.model?.[0]?.timestamp
  return {
    conversation: entry.conversationId,
    id: entry.id,
    kind: entry.kind,
    ...(typeof time === 'number' && { at: new Date(time).toISOString() }),
    excerpt: `${start > 0 ? '…' : ''}${json.slice(start, end)}${end < json.length ? '…' : ''}`,
  }
}

/**
 * Run a search in a worker of its own: concurrent searches run side by side, `signal` terminates it, and a worker that
 * dies fails only its own search.
 */
export function searchChapter(request: SearchRequest, signal: AbortSignal | undefined) {
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { workerData: request })
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>()
  const abort = () => {
    reject(signal!.reason)
    // oxlint-disable-next-line typescript/no-floating-promises -- it resolves with the exit code, which nothing needs.
    worker.terminate()
  }
  signal?.addEventListener('abort', abort, { once: true })
  worker.once('message', resolve)
  worker.once('error', reject)
  // After a message or an error this rejects a settled promise, which does nothing.
  worker.once('exit', (code) => reject(new Error(`search worker exited with code ${code}`)))
  return promise.finally(() => signal?.removeEventListener('abort', abort))
}
