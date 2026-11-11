import { statSync } from 'node:fs'

/**
 * How long before a computation began an input still counts as changing. A file's times come from a coarse clock (a
 * few milliseconds on Linux, seconds on some file systems), so a second edit of the same size in the same tick leaves
 * its stamp as it was. A result read from inputs this young is not kept, as git does not trust a "racily clean" entry.
 */
const RACY_MS = 2000

/** What `path` is now, links followed: device, inode, size, modification and change times, or the error reading it. */
function stamp(path: string) {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
    if (!stats) return { key: 'missing', changed: 0 }
    const { dev, ino, size, mtimeNs, ctimeNs } = stats
    return {
      key: `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`,
      changed: Number((mtimeNs > ctimeNs ? mtimeNs : ctimeNs) / 1_000_000n),
    }
  } catch (error) {
    return { key: (error as NodeJS.ErrnoException).code ?? String(error), changed: 0 }
  }
}

/**
 * Results kept per key while every path they were computed from (each file read, folder listed and path found
 * missing) stats as it did: a hit costs a `stat` per path instead of reading and parsing, and an edit, a new or removed
 * entry in a listed folder, a rename over a file or a repointed link shows on the very next call, whichever process
 * made it. No watcher, so nothing can be missed. Keeps the `kept` most recently used keys; values are shared, so
 * callers must not change them.
 */
export function fileMemo<T>(kept = 32) {
  const entries = new Map<string, { value: T; paths: string[]; stamps: string[] }>()
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      // Deleted and set again, so the map's order is least recently used first.
      entries.delete(key)
      if (entry.paths.some((path, index) => stamp(path).key !== entry.stamps[index]))
        return undefined
      entries.set(key, entry)
      return entry.value
    },
    /** Keep `value`, computed from `paths` by a computation that began at `since` (`Date.now()`), before its reads. */
    set(key: string, value: T, paths: string[], since: number) {
      const stamps = paths.map(stamp)
      entries.delete(key)
      // Stamped after the reads: an input changed while (or just before) they ran may not be what was read.
      if (stamps.some((current) => current.changed > since - RACY_MS)) return
      entries.set(key, { value, paths, stamps: stamps.map((current) => current.key) })
      if (entries.size > kept) entries.delete(entries.keys().next().value!)
    },
  }
}
