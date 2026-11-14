/**
 * Parsers for the Linux `/proc` files the fork's readers use, one per file, over their text: RAM admission
 * (`lib/memory.ts`), CPU measurement (`lib/cpu.ts`), job scopes (`lib/job-scope.ts`) and the Machine dashboard read
 * through these. Upstream's `lib/process-group.ts` keeps its own read of a process's start time.
 */
import { readdir, readFile } from 'node:fs/promises'

/** The fields of a `/proc/<pid>/stat` line that readers use; ticks are clock ticks, `rssPages` pages. */
export type ProcStat = {
  pid: number
  comm: string
  ppid: number
  pgrp: number
  session: number
  /** utime + stime: its own CPU time. */
  ticks: number
  /** cutime + cstime: the CPU time of its children it reaped. */
  childTicks: number
  /** Clock ticks after boot when it started. */
  start: number
  rssPages: number
}
/** A `/proc/<pid>/stat` line, split after the last `)`: `comm` may hold spaces and parentheses. */
export function parseStat(text: string): ProcStat {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  // After the name: state (3), ppid, pgrp, session, …, utime (14), stime, cutime, cstime, …, starttime (22), vsize, rss (24).
  const field = text
    .slice(close + 2)
    .split(' ')
    .map(Number)
  return {
    pid: Number(text.slice(0, open)),
    comm: text.slice(open + 1, close),
    ppid: field[1],
    pgrp: field[2],
    session: field[3],
    ticks: field[11] + field[12],
    childTicks: field[13] + field[14],
    start: field[19],
    rssPages: field[21],
  }
}
/** kthreadd (2) and its children: the kernel's own threads, no memory of their own. */
export const kernelThread = (stat: ProcStat) => stat.pid === 2 || stat.ppid === 2

/** The parent, the group inside this PID namespace (`NSpgid`) and the RSS in KiB of a `/proc/<pid>/status`; 0 when absent. */
export function parseStatus(text: string) {
  const field = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0)
  return { ppid: field('PPid'), pgid: field('NSpgid'), rssKiB: field('VmRSS') }
}

/**
 * `parse` of `/proc/<pid>/<file>` for every process, read concurrently; empty where there is no /proc, and without a
 * process that ended between the listing and the read.
 */
export async function processTable<T>(file: string, parse: (text: string, pid: number) => T) {
  const names = await readdir('/proc').catch(
    // No /proc: not Linux, so there is nothing to read.
    () => [],
  )
  const read = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map((name) =>
        readFile(`/proc/${name}/${file}`, 'utf8').then(
          (text) => parse(text, Number(name)),
          // The process ended between the listing and the read.
          () => undefined,
        ),
      ),
  )
  return read.filter((entry) => entry !== undefined)
}

/** `avg10` of a pressure file's `some` or `full` line (`/proc/pressure/*`, a cgroup's `*.pressure`), in %; 0 when absent. */
export const avg10 = (text: string, line: 'some' | 'full') =>
  Number(new RegExp(`^${line} avg10=([\\d.]+)`, 'm').exec(text)?.[1] ?? 0)

/** The cgroup v2 path in a `/proc/<pid>/cgroup` ("0::/path", among v1 lines on a hybrid system); undefined without one. */
export const cgroupPath = (text: string) => /^0::(\/.*)$/m.exec(text)?.[1]

/** The `kB` fields of `/proc/meminfo` in KiB, by name (`MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`, …). */
export const parseMeminfo = (text: string): Partial<Record<string, number>> =>
  Object.fromEntries(
    text.matchAll(/^([^:\s]+):\s+(\d+) kB$/gm).map(([, name, kib]) => [name, Number(kib)]),
  )

/** The boot time in seconds since the epoch (`btime`) from `/proc/stat`; 0 when absent. */
export const bootTime = (text: string) => Number(/^btime (\d+)$/m.exec(text)?.[1] ?? 0)
