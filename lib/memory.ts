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
import { lstat, mkdir, open, readFile, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readJson, writeJson } from './json-file.ts'
import { JOBS_SLICE } from './job-scope.ts'
import { avg10, cgroupPath, heldMiB, parseMeminfo, parseStatus, processTable } from './proc.ts'
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
  const kib = parseMeminfo(text).MemAvailable
  return kib === undefined ? undefined : Math.floor(kib / 1024)
}

/**
 * Commands that use a lot of RAM, with about how much (MiB), heaviest first. `pnpm check` and `fix` were measured on
 * 2026-11-12 (#227574): their `oxlint-tsgolint` peaks at about 1.7 GB RSS beside a 450 MB node; the rest are estimates.
 */
const heavy: [RegExp, number][] = [
  [/\bpnpm (run )?(check|fix)\b/, 2200],
  [/\b(test:e2e|vitest|playwright)\b|\bpnpm (run )?test\b|\bnode (\S*\/)?server\/main\.ts\b/, 1536],
  [/\bpnpm (run )?(install|build|i)\b|\bvite build\b/, 1024],
]
/** About how much RAM `command` needs, in MiB: 0 unless it runs a known heavy command outside quotes. */
export function commandNeedMiB(command: string) {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '')
  return heavy.find(([pattern]) => pattern.test(unquoted))?.[1] ?? 0
}

/**
 * The soft memory cap of the cgroup Ultimate runs in (`memory.high` of the nearest one up with a finite one, in MiB),
 * what that cgroup uses of it and its memory pressure (`some` and `full` avg10, percent). Every host on the machine and
 * all they start share it (a systemd service cap), so a job that fits in RAM may still not fit under it. `used` is what
 * it holds that the kernel cannot drop (`cgroupHeld`), so cache never keeps a job out. `jobs` is the same of the jobs' own
 * slice (`lib/job-scope.ts`), outside the service: admission counts it against the cap too, which keeps hosts and jobs
 * together within the budget the cap was sized for (5.5 GiB, with about 2 GiB outside the service and the 3 GB floor
 * beside it, #231847).
 */
export type MemoryCap = {
  used: number
  jobs: number
  high: number
  pressure: { some: number; full: number }
}
/** What admission reads of the machine's memory: `MemAvailable` and the cap, each unset where there is none. */
export type MemoryReadings = { available: number | undefined; cap: MemoryCap | undefined }

/** What falls short. `reserved`: MiB promised to jobs admitted within the last minute, counted against both. */
export type RamShort =
  /** Available RAM would drop below the floor. */
  | { kind: 'floor'; available: number; need: number; floor: number; reserved?: number }
  /** The service's memory with its jobs' would rise above the service's soft cap. */
  | { kind: 'cap'; used: number; high: number; need: number; reserved?: number }
/**
 * The decision: undefined when a job needing `need` MiB fits above the floor and under the cap, with `reserved` MiB
 * already promised, else what falls short. No floor (the setting is off) admits everything; no cap adds no rule.
 */
export function ramShort(
  { available, cap }: MemoryReadings,
  need: number,
  floor: number | undefined,
  reserved = 0,
): RamShort | undefined {
  if (floor === undefined) return undefined
  if (available !== undefined && available - reserved - need < floor)
    return { kind: 'floor', available, need, floor, ...(reserved && { reserved }) }
  // #227574: on 2026-11-12 at 01:23 UTC two `pnpm check` runs filled the service to its 5632 MiB soft cap with 5.1 GB
  // of RAM still available: 80 % memory pressure, swap full, checks taking 20 min instead of 30 s.
  if (cap && cap.used + cap.jobs + reserved + need > cap.high)
    return {
      kind: 'cap',
      used: cap.used + cap.jobs,
      high: cap.high,
      need,
      ...(reserved && { reserved }),
    }
  return undefined
}

/** How long an admitted job's need stays reserved: about until its allocations show in `MemAvailable`. */
const SETTLE_MS = 60_000
type Reservation = { need: number; until: number }
const admissions = (dir: string) => join(dir, 'admissions.json')

/**
 * The admission state's folder in `parent`: this user's own, mode 700, never a link, so nobody else can plant a file
 * or a symlink the admission writes through. The heavy-work queue (`lib/slot.ts`) keeps its state here too.
 */
export async function stateDir(parent: string) {
  const uid = process.getuid?.()
  const dir = join(parent, `ultimate-ram-${uid ?? 'user'}`)
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    // Made by an earlier admission; checked below like a new one.
    if (error.code !== 'EEXIST') throw error
  })
  const found = await lstat(dir)
  if (!found.isDirectory() || (uid !== undefined && found.uid !== uid) || found.mode & 0o077)
    throw new Error(
      `${dir} must be a directory of this user's own, mode 700: remove it (another user's needs its owner or root), or set TMPDIR to a private folder`,
    )
  return dir
}
async function reservations(dir: string, now: number) {
  const saved = await readJson<unknown>(admissions(dir), []).catch(
    // A torn or foreign file reserves nothing; the next admission rewrites it.
    () => [],
  )
  return (Array.isArray(saved) ? (saved as Reservation[]) : []).filter(
    (reservation) => reservation.until > now,
  )
}

/**
 * Run `critical` holding the machine's admission lock: a lock file, taken over once it is 10 s old. Two waiters taking
 * over the same stale lock at once may both enter; admission is best effort, and that needs a holder stuck for 10 s.
 */
export async function locked<T>(dir: string, critical: () => Promise<T>) {
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

/** The machine's memory as admission reads it. */
async function readMemory(): Promise<MemoryReadings> {
  const [available, cap] = await Promise.all([availableMiB(), memoryCap()])
  return { available, cap }
}

/** Whether a job needing `need` MiB fits now above `floor` (`memoryFloor`) and under the cap, without admitting it. */
export async function checkRam(floor: number | undefined, need: number, parent = tmpdir()) {
  return floor === undefined ? undefined : shortIn(await stateDir(parent), floor, need, readMemory)
}
/** What a job needing `need` MiB falls short by, with the reservations kept in the state folder `dir`. */
async function shortIn(
  dir: string,
  floor: number,
  need: number,
  read: () => Promise<MemoryReadings>,
) {
  const reserved = (await reservations(dir, Date.now())).reduce((sum, item) => sum + item.need, 0)
  return ramShort(await read(), need, floor, reserved)
}

/**
 * Admit a job needing `need` MiB: undefined when it fits, and its need is then reserved; else what falls short. `read`
 * is what it reads the machine's memory with.
 */
export async function admitRam(
  floor: number | undefined,
  need: number,
  parent = tmpdir(),
  read = readMemory,
) {
  if (floor === undefined) return undefined
  const dir = await stateDir(parent)
  return locked(dir, () => admitIn(dir, floor, need, read))
}
/** `admitRam` for a caller that already holds the lock of the state folder `dir`. */
export async function admitIn(
  dir: string,
  floor: number | undefined,
  need: number,
  read = readMemory,
) {
  if (floor === undefined) return undefined
  const short = await shortIn(dir, floor, need, read)
  if (!short && need) {
    const now = Date.now()
    await writeJson(admissions(dir), [
      ...(await reservations(dir, now)),
      { need, until: now + SETTLE_MS },
    ])
  }
  return short
}

const gib = (mib: number) => (mib / 1024).toFixed(1)
/**
 * "4200 MiB available (1536 MiB of it reserved by jobs just started), needs 1536 MiB above the 3072 MiB floor", or
 * "5.6 of 5.5 GiB of the service's memory cap in use by hosts and jobs, needs 2200 MiB under it".
 */
export const describeShort = (short: RamShort) =>
  short.kind === 'floor'
    ? `${short.available} MiB available${short.reserved ? ` (${short.reserved} MiB of it reserved by jobs just started)` : ''}, needs ${short.need ? `${short.need} MiB above ` : 'more than '}the ${short.floor} MiB floor`
    : `${gib(short.used)} of ${gib(short.high)} GiB of the service's memory cap in use by hosts and jobs${short.reserved ? ` and ${short.reserved} MiB more reserved by jobs just started` : ''}, needs ${short.need ? `${short.need} MiB under it` : 'room under it'}`

/** The cgroup (v2) path of this process, e.g. `/user.slice/…/ultimate.service`; undefined where there is none. */
async function ownCgroup() {
  return cgroupPath(
    await readFile('/proc/self/cgroup', 'utf8').catch(
      // Not Linux: no cgroup.
      () => '',
    ),
  )
}

const mib = (text: string) =>
  /^\d+$/.test(text.trim()) ? Math.round(Number(text) / 2 ** 20) : undefined
/**
 * What the cgroup at `dir` holds that the kernel cannot drop (`heldMiB`). Anonymous memory stays, whose growth past
 * the cap is the reclaim to keep out of (#227574).
 *
 * #298279: a job's file cache stays charged to the jobs' slice after its scope ends, and nothing reclaims it there
 * (the slice has no limit of its own). On 2026-11-14 the slice held 2,472 MiB, 2,360 of it file cache and none
 * anonymous, and a count that left out only the inactive file cache kept a `pnpm fix` waiting 30 min under a cap
 * "3.4 of 5.5 GiB in use", with 10 GiB of RAM available.
 */
async function cgroupHeld(dir: string) {
  const [current, stat] = await Promise.all([
    readFile(join(dir, 'memory.current'), 'utf8').then(mib),
    readFile(join(dir, 'memory.stat'), 'utf8'),
  ])
  return current === undefined ? undefined : heldMiB(current, stat)
}

/**
 * The memory cap admission counts (`MemoryCap`): from this process's cgroup up, the nearest with a finite
 * `memory.high`; undefined when none has one (or there are no cgroups).
 */
export async function memoryCap(): Promise<MemoryCap | undefined> {
  const path = await ownCgroup()
  if (!path) return undefined
  for (let at = path; ; at = dirname(at)) {
    const dir = join('/sys/fs/cgroup', at)
    const high = mib(
      await readFile(join(dir, 'memory.high'), 'utf8').catch(
        // No memory controller here: look further up.
        () => '',
      ),
    )
    if (high !== undefined) {
      // The jobs' slice counts once: a capped cgroup that contains it already counts it in its own figure.
      const outside = at !== '/' && !JOBS_SLICE.startsWith(`${at}/`)
      const [used, jobs, pressure] = await Promise.all([
        cgroupHeld(dir),
        outside
          ? cgroupHeld(join('/sys/fs/cgroup', JOBS_SLICE)).catch(
              // No slice: no job has run in one since it was last emptied and removed, or jobs get no scopes here.
              () => 0,
            )
          : 0,
        readFile(join(dir, 'memory.pressure'), 'utf8').catch(
          // A kernel without pressure stall information: none to show.
          () => '',
        ),
      ])
      if (used === undefined) return undefined
      return {
        used,
        jobs: jobs ?? 0,
        high,
        pressure: { some: avg10(pressure, 'some'), full: avg10(pressure, 'full') },
      }
    }
    if (at === '/') return undefined
  }
}

/** The memory controller of this process's cgroup (v2), in MiB; `high` and `max` unset when unlimited. */
export async function cgroupMemory() {
  const path = await ownCgroup()
  if (!path) return undefined
  const read = (name: string) =>
    readFile(join('/sys/fs/cgroup', path, name), 'utf8').then(
      mib,
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

/** From `/status`, not `/stat`: its `VmRSS` comes in KiB where `/stat` counts pages, whose size only `getconf` knows. */
const processes = () => processTable('status', (text, pid) => ({ pid, ...parseStatus(text) }))
type Proc = Awaited<ReturnType<typeof processes>>[number]
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
 * The process groups of `root` and everything it started, by RSS, the largest eight: previews, scratch servers,
 * background commands and test runs. A group is named by its topmost process, and by `names` (by group id) when there.
 */
export async function memoryUsers(
  root = process.pid,
  { names = new Map<number, string>() } = {},
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
    .slice(0, 8)
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
