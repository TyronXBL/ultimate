import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const LIMIT = 1000

/** Reserve a Tavily call before sending it. A failed or interrupted call still spends its reservation. */
export async function reserveSearch(
  userHome: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const dir = join(userHome, '.ultimate')
  const path = join(dir, 'tavily-budget.sqlite')
  let created = false
  try {
    const file = await open(path, 'wx', 0o600)
    created = true
    await file.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (created) {
    // Persist the database entry before the schema permits any reservation.
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  const db = new DatabaseSync(path)
  try {
    if (created) {
      for (;;) {
        try {
          db.exec('BEGIN IMMEDIATE')
          try {
            db.exec(`CREATE TABLE budget (month TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 1000)) STRICT;
              PRAGMA user_version = 1;
              COMMIT;`)
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
          break
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
    for (;;) {
      signal?.throwIfAborted()
      try {
        db.exec('BEGIN IMMEDIATE')
        try {
          const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
          if (version.user_version !== 1) throw new Error('Invalid Tavily budget state.')
          const rows = db.prepare('SELECT month, used FROM budget').all() as {
            month: string
            used: number
          }[]
          if (
            rows.some(
              (row) =>
                !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) ||
                !Number.isInteger(row.used) ||
                row.used < 1 ||
                row.used > LIMIT,
            )
          )
            throw new Error('Invalid Tavily budget state.')
          const month = new Date().toISOString().slice(0, 7)
          const used = rows.find((row) => row.month === month)?.used ?? 0
          if (used >= LIMIT) {
            db.exec('COMMIT')
            return null
          }
          db.prepare(
            'INSERT INTO budget (month, used) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET used = used + 1',
          ).run(month)
          db.exec('COMMIT')
          return used + 1
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ERR_SQLITE_ERROR' ||
          !/database is locked/.test((error as Error).message)
        )
          throw error
        await sleep(100, undefined, { signal })
      }
    }
  } finally {
    db.close()
  }
}
