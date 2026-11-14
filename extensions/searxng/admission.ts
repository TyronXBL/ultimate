import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { identify } from '../../lib/process-group.ts'

/**
 * Retry SQLite's short write locks without blocking the event loop. The first try runs even when `signal` is
 * aborted: the Tavily budget's first schema write must not be skipped (#229140); callers check it themselves.
 */
async function write<T>(action: () => T, signal?: AbortSignal): Promise<T> {
  for (;;) {
    try {
      return action()
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ERR_SQLITE_ERROR' ||
        !/database is locked/.test((error as Error).message)
      )
        throw error
      await sleep(100, undefined, { signal })
    }
  }
}

/** `action` in one immediate transaction, committed when it returns, retried while another writer holds the lock. */
export function transaction<T>(db: DatabaseSync, action: () => T, signal?: AbortSignal) {
  return write(() => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }, signal)
}

/** Admit at most two searches across hosts. SQLite serializes claims and releases after a crash. */
export async function admitSearch(
  userHome: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const dir = join(userHome, '.ultimate')
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'web-search-admission.sqlite'))
  const id = randomUUID()
  const identity = identify(process.pid)
  if (!identity) {
    db.close()
    throw new Error('Cannot identify the search process.')
  }
  try {
    signal?.throwIfAborted()
    await write(
      () =>
        db.exec(
          'CREATE TABLE IF NOT EXISTS holders (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, identity TEXT NOT NULL)',
        ),
      signal,
    )
    for (;;) {
      signal?.throwIfAborted()
      const entered = await transaction(
        db,
        () => {
          const rows = db.prepare('SELECT id, pid, identity FROM holders').all() as {
            id: string
            pid: number
            identity: string
          }[]
          for (const row of rows) {
            if (identify(row.pid) !== row.identity)
              db.prepare('DELETE FROM holders WHERE id = ?').run(row.id)
          }
          const count = db.prepare('SELECT count(*) AS n FROM holders').get() as { n: number }
          if (count.n >= 2) return false
          db.prepare('INSERT INTO holders VALUES (?, ?, ?)').run(id, process.pid, identity)
          return true
        },
        signal,
      )
      if (entered) {
        return async () => {
          try {
            await write(() => db.prepare('DELETE FROM holders WHERE id = ?').run(id))
          } finally {
            db.close()
          }
        }
      }
      await sleep(100, undefined, { signal })
    }
  } catch (error) {
    db.close()
    throw error
  }
}
