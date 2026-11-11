import { statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * How long before a computation began an input still counts as changing. A file's times come from a coarse clock (a
 * few milliseconds on Linux, seconds on some file systems), so a second edit of the same size in the same tick leaves
 * its stamp as it was. A result read from inputs this young is not kept, as git does not trust a "racily clean" entry.
 */
const RACY_MS = 2000
/** Keys kept per memo, least recently used dropped first: every worktree is a key of its own. */
const KEPT = 32

/** What `path` is now, links followed: device, inode, size, modification and change times, or why it has none. */
function stamp(path: string) {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    return stats
      ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
      : 'missing'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? String(error)
  }
}

/**
 * When `path` last changed, in milliseconds: its own modification or change time, or for a missing path its nearest
 * existing folder's, which changed when it was removed. An error counts as now.
 */
function changedAt(path: string): number {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    if (!stats) return dirname(path) === path ? 0 : changedAt(dirname(path))
    return Number((stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs) / 1_000_000n)
  } catch {
    // Unreadable: nothing tells when it changed, so it counts as changing now and is not kept.
    return Date.now()
  }
}

/**
 * Results kept per key while every path they were computed from (each file read, folder listed and path found
 * missing) stats as it did: a hit costs a `stat` per path instead of reading and parsing, and an edit, a new or removed
 * entry in a listed folder, a rename over a file or a repointed link shows on the very next call, whichever process
 * made it. No watcher, so nothing can be missed (#222319). Values are shared, so callers must not change them.
 */
export function fileMemo<T>() {
  const entries = new Map<string, { value: T; paths: string[]; stamps: string[] }>()
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      // Deleted and set again, so the map's order is least recently used first.
      entries.delete(key)
      if (entry.paths.some((path, index) => stamp(path) !== entry.stamps[index])) return undefined
      entries.set(key, entry)
      return entry.value
    },
    /** Keep `value`, computed from `paths` by a computation that began at `since` (`Date.now()`), before its reads. */
    set(key: string, value: T, paths: string[], since: number) {
      const stamps = paths.map(stamp)
      entries.delete(key)
      // Stamped after the reads: an input changed (or removed) while or just before they ran may not be what was read.
      if (paths.some((path) => changedAt(path) > since - RACY_MS)) return
      entries.set(key, { value, paths, stamps })
      if (entries.size > KEPT) entries.delete(entries.keys().next().value!)
    },
  }
}
