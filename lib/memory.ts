/**
 * This machine's RAM floor: `memory.minAvailableMiB` in settings is how much RAM must stay available. The heavy jobs
 * Ultimate starts (background commands, lander checks, previews, heavy bash commands) look here first and wait or
 * refuse when their estimated need would take available RAM below it. Linux only: elsewhere nothing is read and
 * nothing is gated.
 */
import { readdir, readFile, readlink } from 'node:fs/promises'
import type { JsonObject } from '@earendil-works/pi-durable'

/** About what a preview or a scratch server needs: a booted Ultimate with its web build. */
export const PREVIEW_MIB = 1536
/** How long a durable wait for RAM lasts before it gives up, and how often it looks again. */
export const RAM_WAIT_MS = 30 * 60_000
export const RAM_POLL_MS = 10_000

/** The floor in MiB, undefined while off (the default). */
export function memoryFloor(settings: JsonObject) {
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

export type RamShort = { available: number; need: number; floor: number }
/** The decision: undefined when a job needing `need` MiB fits above the floor, else what falls short. */
export function ramShort(available: number | undefined, need: number, floor: number | undefined) {
  if (available === undefined || floor === undefined || available - need >= floor) return undefined
  return { available, need, floor } satisfies RamShort
}

/** Whether a job needing `need` MiB fits now, by the floor in `settings`. */
export const checkRam = async (settings: JsonObject, need: number) => {
  const floor = memoryFloor(settings)
  return floor === undefined ? undefined : ramShort(await availableMiB(), need, floor)
}

/** "4200 MiB available, needs 1536 MiB above the 3072 MiB floor". */
export const describeShort = ({ available, need, floor }: RamShort) =>
  `${available} MiB available, needs ${need ? `${need} MiB above ` : 'more than '}the ${floor} MiB floor`

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
