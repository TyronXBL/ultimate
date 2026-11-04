/**
 * This machine's RAM floor: `memory.minAvailableMiB` in `~/.ultimate/settings.json` is how much RAM must stay available. The heavy jobs
 * Ultimate starts (background commands, lander checks, previews, heavy bash commands) look here first and wait or
 * refuse when their estimated need would take available RAM below it. Linux only: elsewhere nothing is read and
 * nothing is gated.
 *
 * Admission is best effort: an estimate, and RAM that something else may take later. It is serialized, though: one
 * lock for every starter on the machine (previews share `TMPDIR` with their host), and each admitted job reserves its
 * need for a minute, until its own allocations show in `MemAvailable`, so two starters never both pass on the same RAM.
 */
import { lstat, open, readdir, readFile, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readJson, writeJson } from './json-file.ts'
import { readSettings, userSettingsPath } from './settings.ts'

/** About what a preview or a scratch server needs: a booted Ultimate with its web build. */
export const PREVIEW_MIB = 1536
/** How long a durable wait for RAM lasts before it gives up, and how often it looks again. */
export const RAM_WAIT_MS = 30 * 60_000
export const RAM_POLL_MS = 10_000

/**
 * The floor in MiB from this machine's settings, undefined while off (the default). A machine setting: project settings
 * travel with the repository to machines with other RAM.
 */
export async function memoryFloor(userHome: string) {
  const settings = await readSettings(userSettingsPath(userHome)).catch(
    // Unreadable settings: the setup status reports them; nothing is gated meanwhile.
    (): JsonObject => ({}),
  )
  const memory = settings.memory
  const floor =
    memory && typeof memory === 'object' && !Array.isArray(memory)
      ? memory.minAvailableMiB
      : undefined
  return typeof floor === 'number' && floor > 0 ? floor : undefined
}

/** `MemAvailable` from `/proc/meminfo` in MiB; undefined where there is none (not Linux). */
export async function availableMiB(meminfo = '/proc/meminfo') {
  const text = await readFile(meminfo, 'utf8').catch(
    // No /proc/meminfo: not Linux, so nothing is gated.
    () => '',
  )
  const kib = /^MemAvailable:\s+(\d+) kB$/m.exec(text)?.[1]
  return kib === undefined ? undefined : Math.floor(Number(kib) / 1024)
}

/** Commands that use a lot of RAM, with about how much (MiB), heaviest first. */
const heavy: [RegExp, number][] = [
  [/\b(test:e2e|vitest|playwright)\b|\bpnpm (run )?test\b|\bnode (\S*\/)?server\/main\.ts\b/, 1536],
  [/\bpnpm (run )?(check|fix|install|build|i)\b|\bvite build\b/, 1024],
]
/** About how much RAM `command` needs, in MiB: 0 unless it runs a known heavy command outside quotes. */
export function commandNeedMiB(command: string) {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '')
  return heavy.find(([pattern]) => pattern.test(unquoted))?.[1] ?? 0
}

/** `reserved`: MiB of `available` promised to jobs admitted within the last minute. */
export type RamShort = { available: number; need: number; floor: number; reserved?: number }
/**
 * The decision: undefined when a job needing `need` MiB fits above the floor, with `reserved` MiB already promised,
 * else what falls short.
 */
export function ramShort(
  available: number | undefined,
  need: number,
  floor: number | undefined,
  reserved = 0,
) {
  if (available === undefined || floor === undefined || available - reserved - need >= floor)
    return undefined
  return { available, need, floor, ...(reserved && { reserved }) } satisfies RamShort
}

/** How long an admitted job's need stays reserved: about until its allocations show in `MemAvailable`. */
const SETTLE_MS = 60_000
type Reservation = { need: number; until: number }
const admissions = (dir: string) => join(dir, 'ultimate-ram-admissions.json')
async function reservations(dir: string, now: number) {
  const saved = await readJson<unknown>(admissions(dir), []).catch(
    // A torn or foreign file reserves nothing; the next admission rewrites it.
    () => [],
  )
  return (Array.isArray(saved) ? (saved as Reservation[]) : []).filter(
    (reservation) => reservation.until > now,
  )
}

/** Run `critical` holding the machine's admission lock: a lock file, taken over once it is 10 s old. */
async function locked<T>(dir: string, critical: () => Promise<T>) {
  const lock = join(dir, 'ultimate-ram.lock')
  for (;;) {
    try {
      await (await open(lock, 'wx')).close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const held = await lstat(lock).catch(
      // Released between the two looks: try again at once.
      () => undefined,
    )
    if (held && Date.now() - held.mtimeMs > 10_000) await rm(lock, { force: true })
    else if (held) await sleep(50)
  }
  try {
    return await critical()
  } finally {
    await rm(lock, { force: true })
  }
}

/** Whether a job needing `need` MiB fits now above `floor` (`memoryFloor`), without admitting it. */
export async function checkRam(floor: number | undefined, need: number, dir = tmpdir()) {
  if (floor === undefined) return undefined
  const reserved = (await reservations(dir, Date.now())).reduce((sum, item) => sum + item.need, 0)
  return ramShort(await availableMiB(), need, floor, reserved)
}

/** Admit a job needing `need` MiB: undefined when it fits, and its need is then reserved; else what falls short. */
export async function admitRam(floor: number | undefined, need: number, dir = tmpdir()) {
  if (floor === undefined) return undefined
  return locked(dir, async () => {
    const short = await checkRam(floor, need, dir)
    if (!short && need) {
      const now = Date.now()
      await writeJson(admissions(dir), [
        ...(await reservations(dir, now)),
        { need, until: now + SETTLE_MS },
      ])
    }
    return short
  })
}

/** "4200 MiB available (1536 MiB of it reserved by jobs just started), needs 1536 MiB above the 3072 MiB floor". */
export const describeShort = ({ available, need, floor, reserved }: RamShort) =>
  `${available} MiB available${reserved ? ` (${reserved} MiB of it reserved by jobs just started)` : ''}, needs ${need ? `${need} MiB above ` : 'more than '}the ${floor} MiB floor`

/** The memory controller of this process's cgroup (v2), in MiB; `high` and `max` unset when unlimited. */
export async function cgroupMemory() {
  const path = /^0::(\/.*)$/m.exec(
    await readFile('/proc/self/cgroup', 'utf8').catch(
      // Not Linux: no cgroup.
      () => '',
    ),
  )?.[1]
  if (!path) return undefined
  const read = (name: string) =>
    readFile(join('/sys/fs/cgroup', path, name), 'utf8').then(
      (text) => (/^\d+$/.test(text.trim()) ? Math.round(Number(text) / 2 ** 20) : undefined),
      // No memory controller for this cgroup.
      () => undefined,
    )
  const [current, high, max] = await Promise.all([
    read('memory.current'),
    read('memory.high'),
    read('memory.max'),
  ])
  if (current === undefined || (high === undefined && max === undefined)) return undefined
  return { current, ...(high !== undefined && { high }), ...(max !== undefined && { max }) }
}

/** A process group Ultimate started and the RAM its processes use. */
export type MemoryUser = {
  pgid: number
  rssMiB: number
  processes: number
  /** The command line of the group's topmost process, shortened. */
  command: string
  /** What the caller knows it as: "preview 1f3a…". */
  name?: string
  cwd?: string
}

type Proc = { pid: number; ppid: number; pgid: number; rssKiB: number }
const field = (status: string, name: string) =>
  Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0)
async function processes() {
  const names = await readdir('/proc').catch(
    // No /proc: not Linux.
    () => [],
  )
  const read = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map((name) =>
        readFile(`/proc/${name}/status`, 'utf8').then(
          (status): Proc => ({
            pid: Number(name),
            ppid: field(status, 'PPid'),
            pgid: field(status, 'NSpgid'),
            rssKiB: field(status, 'VmRSS'),
          }),
          // The process ended between the listing and the read.
          () => undefined,
        ),
      ),
  )
  return read.filter((proc) => proc !== undefined)
}
/** Shown command: the program's name, then its arguments, at most 100 characters. */
async function commandOf(pid: number) {
  const argv = (
    await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(
      // The process ended since it was listed.
      () => '',
    )
  )
    .split('\0')
    .filter(Boolean)
  const [program = '?', ...rest] = argv
  const text = [program.split('/').pop(), ...rest].join(' ').replace(/\s+/g, ' ')
  return text.length > 100 ? `${text.slice(0, 99)}…` : text
}
/**
 * The process groups of `root` and everything it started, by RSS, the largest `limit`: previews, scratch servers,
 * background commands and test runs. A group is named by its topmost process, and by `names` (by group id) when there.
 */
export async function memoryUsers(
  root = process.pid,
  { limit = 8, names = new Map<number, string>() } = {},
): Promise<MemoryUser[]> {
  const all = await processes()
  const children = Map.groupBy(all, (proc) => proc.ppid)
  const mine: Proc[] = []
  const queue = all.filter((proc) => proc.pid === root)
  for (let proc = queue.shift(); proc; proc = queue.shift()) {
    mine.push(proc)
    queue.push(...(children.get(proc.pid) ?? []))
  }
  const pids = new Map(mine.map((proc) => [proc.pid, proc]))
  const groups = [...Map.groupBy(mine, (proc) => proc.pgid).values()]
    .map((members) => ({
      members,
      top: members.find((proc) => pids.get(proc.ppid)?.pgid !== proc.pgid) ?? members[0],
      rssKiB: members.reduce((sum, proc) => sum + proc.rssKiB, 0),
    }))
    .toSorted((a, b) => b.rssKiB - a.rssKiB)
    .slice(0, limit)
  return Promise.all(
    groups.map(async ({ members, top, rssKiB }) => ({
      pgid: top.pgid,
      rssMiB: Math.round(rssKiB / 1024),
      processes: members.length,
      command: await commandOf(top.pid),
      ...(names.has(top.pgid) && { name: names.get(top.pgid) }),
      ...(await readlink(`/proc/${top.pid}/cwd`).then(
        (cwd) => ({ cwd }),
        // Another user's process or one that ended: no directory to show.
        () => ({}),
      )),
    })),
  )
}

/** One line per user: "1530 MiB  vitest run … (in /path)". */
export const listUsers = (users: MemoryUser[]) =>
  users
    .map(
      (user) =>
        `- ${user.rssMiB} MiB  ${user.name ? `${user.name}: ` : ''}${user.command}${user.cwd ? `  (in ${user.cwd})` : ''}  [group ${user.pgid}]`,
    )
    .join('\n')
