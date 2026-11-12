/**
 * One look at the machine: `/proc` (load, memory, swap, every process's CPU and RSS), the temp folders' file systems and
 * the heavy-work queue through `lib/slot.ts`. Linux only; elsewhere the process list and memory read empty. Reads
 * nothing that needs root: another user's processes show by program name only.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile, readlink, statfs } from 'node:fs/promises'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { checkRam, commandNeedMiB, memoryFloor } from '../../lib/memory.ts'
import { peekSlot, queueTmpdir, slotLabel } from '../../lib/slot.ts'
import { cpuByKind, homeOf, owners } from './owners.ts'
import type { OwnerContext, Proc, Top } from './owners.ts'
import { END_OF_LINE, fromOf, holdersOf, queueView } from './queue.ts'
import type { Turn } from './queue.ts'
import type { MachineState, Owner, Pressure, Sample, TempUse } from './refs.ts'

/** What carries over from one look to the next: CPU counters and the tops' command lines, by pid and start time. */
export type Memory = {
  at: number
  ticks: Map<string, number>
  tops: Map<string, Top>
  /** Project homes' names (`homeOf`), read once each. */
  homes: Map<string, string>
}
export const emptyMemory = (): Memory => ({
  at: 0,
  ticks: new Map(),
  tops: new Map(),
  homes: new Map(),
})

/** `getconf`'s answer, read once: clock ticks per second and the page size, 100 and 4096 on most Linux machines. */
const conf = (name: string, fallback: number) => {
  try {
    return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim()) || fallback
  } catch {
    // No getconf (not Linux): no process is read either.
    return fallback
  }
}
let known: { tick: number; page: number; boot: number } | undefined
async function unitsOf() {
  const boot = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1] ?? 0)
  return (known ??= { tick: conf('CLK_TCK', 100), page: conf('PAGESIZE', 4096), boot })
}

type Raw = Omit<Proc, 'cpu'> & { start: string; ticks: number }
/**
 * Every process from `/proc/<pid>/stat`, kernel threads left out. Read synchronously: about 6 ms for 300 processes,
 * where the same reads through the thread pool cost four times the CPU.
 */
async function processes(): Promise<Raw[]> {
  const { tick, page, boot } = await unitsOf()
  const found: Raw[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8')
    } catch {
      // The process ended between the listing and the read.
      continue
    }
    // The name sits in parentheses and may hold spaces; the fields after it are plain numbers.
    const close = stat.lastIndexOf(')')
    const fields = stat.slice(close + 2).split(' ')
    const pid = Number(name)
    const ppid = Number(fields[1])
    // kthreadd (2) and its children: the kernel's own threads, no memory of their own.
    if (pid === 2 || ppid === 2) continue
    found.push({
      pid,
      name: stat.slice(stat.indexOf('(') + 1, close),
      ppid,
      pgid: Number(fields[2]),
      ticks: Number(fields[11]) + Number(fields[12]),
      start: fields[19],
      since: (boot + Number(fields[19]) / tick) * 1000,
      rssKiB: (Number(fields[21]) * page) / 1024,
    })
  }
  return found
}

/**
 * A background command's wrapper (`extensions/background`) runs `bash -c "$BACKGROUND_COMMAND"`: its command is in its
 * environment, shown as the queue shows it (`slotLabel`: the first line, at most 80 characters). Nothing else of the
 * environment is kept.
 */
async function backgroundCommand(pid: number) {
  const environment = await readFile(`/proc/${pid}/environ`, 'utf8').catch(
    // Ended since it was listed.
    () => '',
  )
  const found = environment.split('\0').find((entry) => entry.startsWith('BACKGROUND_COMMAND='))
  return found && slotLabel(found.slice('BACKGROUND_COMMAND='.length))
}

async function topOf(pid: number): Promise<Top> {
  const [argv, cwd] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`, 'utf8').then(
      (text) => text.split('\0').filter(Boolean),
      // Ended since it was listed.
      () => [],
    ),
    readlink(`/proc/${pid}/cwd`).catch(
      // Another user's process, or one that ended: no folder to tell it by.
      () => undefined,
    ),
  ])
  const command = argv.some((word) => word.includes('$BACKGROUND_COMMAND'))
    ? await backgroundCommand(pid)
    : undefined
  return { argv, ...(cwd && { cwd }), ...(command && { command }) }
}

const mib = (kib: string | undefined) => Math.round(Number(kib ?? 0) / 1024)
async function memInfo() {
  const text = await readFile('/proc/meminfo', 'utf8').catch(
    // Not Linux: nothing to show.
    () => '',
  )
  const field = (name: string) => mib(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text)?.[1])
  return {
    totalMiB: field('MemTotal'),
    availableMiB: field('MemAvailable'),
    swapTotalMiB: field('SwapTotal'),
    swapUsedMiB: field('SwapTotal') - field('SwapFree'),
  }
}

/** `some avg10` of a pressure file, in %: 0 where the kernel keeps none. */
const stalled = (path: string) =>
  readFile(path, 'utf8').then(
    (text) => Number(/^some avg10=([\d.]+)/m.exec(text)?.[1] ?? 0),
    // No pressure stall information (not Linux, or a kernel without it).
    () => 0,
  )

/** Tasks machine-wide stalled on CPU, IO and memory. */
async function stalls() {
  const [cpu, io, memory] = await Promise.all(
    ['cpu', 'io', 'memory'].map((resource) => stalled(`/proc/pressure/${resource}`)),
  )
  return { cpu, io, memory }
}

/**
 * The memory controller of the cgroup this process runs in (v2): what it holds, its caps (unset when unlimited) and how
 * much its tasks stall on memory. Undefined without one.
 */
async function cgroup() {
  const path = /^0::(\/.*)$/m.exec(
    await readFile('/proc/self/cgroup', 'utf8').catch(
      // Not Linux: no cgroup.
      () => '',
    ),
  )?.[1]
  if (!path) return undefined
  const dir = join('/sys/fs/cgroup', path)
  const bytes = (name: string) =>
    readFile(join(dir, name), 'utf8').then(
      (text) => (/^\d+$/.test(text.trim()) ? Math.round(Number(text) / 2 ** 20) : undefined),
      // No memory controller here; `max` (unlimited) reads as no number too.
      () => undefined,
    )
  const [currentMiB, highMiB, maxMiB, stall] = await Promise.all([
    bytes('memory.current'),
    bytes('memory.high'),
    bytes('memory.max'),
    stalled(join(dir, 'memory.pressure')),
  ])
  if (currentMiB === undefined) return undefined
  return {
    name: basename(path),
    currentMiB,
    stall,
    ...(highMiB !== undefined && { highMiB }),
    ...(maxMiB !== undefined && { maxMiB }),
  }
}

/** `statfs`'s type of a RAM file system. */
const TMPFS = 0x01021994
async function temp(): Promise<TempUse[]> {
  const places = [
    { name: '$TMPDIR', path: tmpdir() },
    { name: '/tmp', path: '/tmp' },
  ].filter((place, index, all) => all.findIndex((other) => other.path === place.path) === index)
  const read = await Promise.all(
    places.map(({ name, path }) =>
      statfs(path).then(
        (fs): TempUse => ({
          name,
          path,
          sizeMiB: Math.round((fs.blocks * fs.bsize) / 2 ** 20),
          usedMiB: Math.round(((fs.blocks - fs.bfree) * fs.bsize) / 2 ** 20),
          ram: fs.type === TMPFS,
        }),
        // A folder that is not there holds nothing.
        () => undefined,
      ),
    ),
  )
  return read.filter((use) => use !== undefined)
}

/** What needs attention now. */
function pressureOf(state: {
  load: number
  cores: number
  availableMiB: number
  floorMiB?: number
  temp: TempUse[]
  outside: number
  stall: Sample['stall']
  cgroup?: Awaited<ReturnType<typeof cgroup>>
}): Pressure[] {
  const found: Pressure[] = []
  const { floorMiB, availableMiB, cgroup: group } = state
  if (
    group &&
    ((group.highMiB !== undefined && group.currentMiB >= group.highMiB - 256) || group.stall >= 20)
  )
    found.push({
      kind: 'cgroup',
      name: group.name,
      currentMiB: group.currentMiB,
      stall: group.stall,
      ...(group.highMiB !== undefined && { highMiB: group.highMiB }),
    })
  for (const resource of ['memory', 'io'] as const)
    if (state.stall[resource] >= 20)
      found.push({ kind: 'stall', resource, pct: state.stall[resource] })
  // Within 1 GiB of the floor, as the memory extension's chip.
  if (floorMiB !== undefined && availableMiB < floorMiB + 1024)
    found.push({ kind: 'ram', availableMiB, floorMiB, below: availableMiB < floorMiB })
  // A heavy job alone keeps the load near the cores; well above, more runs than the machine has.
  if (state.load >= state.cores * 1.5)
    found.push({ kind: 'load', load: state.load, cores: state.cores })
  for (const use of state.temp)
    if (use.usedMiB >= use.sizeMiB * 0.9)
      found.push({ kind: 'temp', name: use.name, usedMiB: use.usedMiB, sizeMiB: use.sizeMiB })
  if (state.outside > 1) found.push({ kind: 'outside', cores: state.outside })
  return found
}

/**
 * The name of each project home a process runs in, from its `project.json`, read once per home. Found from the
 * processes, not this host's project list: a preview has a list of its own and still sees the whole machine.
 */
async function namesOf(tops: Iterable<Top>, homes: Map<string, string>) {
  for (const top of tops) {
    const home = top.cwd && homeOf(top.cwd)?.home
    if (!home || homes.has(home)) continue
    const root = await readFile(join(home, 'project.json'), 'utf8').then(
      (text) => (JSON.parse(text) as { root?: unknown }).root,
      // No readable manifest: the home's folder name stands in.
      () => undefined,
    )
    // The queue names a project by its checkout's folder: `#12 in my-app`.
    homes.set(
      home,
      typeof root === 'string' ? basename(root) : basename(home).replace(/-[0-9a-f]{8}$/, ''),
    )
  }
  return homes
}

/** How many owners the state lists; the rest add up in `more`. */
const LISTED = 12

/** Look at the machine once; `memory` carries the counters to the next look. */
export async function look(
  memory: Memory,
  host: { userHome: string; projectRoot: string },
): Promise<{ sample: Sample; state: Omit<MachineState, 'samples' | 'now'> }> {
  const now = Date.now()
  const turn: Turn = await peekSlot(END_OF_LINE)
  const holders = holdersOf(turn)
  const [raw, mem, places, floorMiB, units, stall, group] = await Promise.all([
    processes().catch(
      // No /proc: not Linux.
      () => [],
    ),
    memInfo(),
    temp(),
    memoryFloor(host.userHome),
    unitsOf().catch(
      // No /proc: not Linux.
      () => ({ tick: 100 }),
    ),
    stalls(),
    cgroup(),
  ])
  const seconds = (now - memory.at) / 1000
  const ticks = new Map<string, number>()
  const procs: Proc[] = raw.map(({ start, ticks: used, ...proc }) => {
    const key = `${proc.pid}:${start}`
    ticks.set(key, used)
    const before = memory.ticks.get(key)
    // A process new since the last look counts from its start (at least half a second, so a fresh one is no spike).
    const spent = used - (before ?? 0)
    const over =
      before === undefined ? Math.max(0.5, Math.min(seconds, (now - proc.since) / 1000)) : seconds
    return { ...proc, cpu: memory.at && over > 0 ? spent / units.tick / over : 0 }
  })
  // Command lines and folders of each group's topmost process, read once per process.
  const byPid = new Map(raw.map((proc) => [proc.pid, proc]))
  const tops = new Map<number, Top>()
  const kept = new Map<string, Top>()
  await Promise.all(
    raw
      .filter((proc) => byPid.get(proc.ppid)?.pgid !== proc.pgid)
      .map(async (proc) => {
        const key = `${proc.pid}:${proc.start}`
        const top = memory.tops.get(key) ?? (await topOf(proc.pid))
        kept.set(key, top)
        tops.set(proc.pid, top)
      }),
  )
  memory.at = now
  memory.ticks = ticks
  memory.tops = kept
  const jobs: OwnerContext['jobs'] = new Map(
    holders.map((job) => [job.holder.pid, { job: job.id, label: job.label, ...fromOf(job.from) }]),
  )
  const homes = await namesOf(tops.values(), memory.homes)
  const all = owners(procs, tops, { homes, jobs })
  const cores = availableParallelism()
  const load = Math.round(loadavg()[0] * 100) / 100
  const first = turn.ahead?.[0]
  const short =
    first && !holders.length
      ? await checkRam(floorMiB, commandNeedMiB(first.label), queueTmpdir())
      : undefined
  const queue = queueView(turn, {
    now,
    load,
    cores,
    ...(short && { short }),
    usage: new Map(
      all
        .filter((owner): owner is Owner & { job: string } => owner.job !== undefined)
        .map((owner) => [owner.job, { cpu: owner.cpu, rssMiB: owner.rssMiB }]),
    ),
  })
  const cpu = cpuByKind(all)
  // Previews and browsers hold memory jobs wait for: they are listed however idle.
  const listed = all.filter(
    (owner, index) => index < LISTED || owner.kind === 'preview' || owner.kind === 'browser',
  )
  const rest = all.filter((owner) => !listed.includes(owner))
  return {
    sample: {
      at: now,
      load,
      cpu,
      availableMiB: mem.availableMiB,
      swapUsedMiB: mem.swapUsedMiB,
      stall,
      ...(group && { cgroup: { currentMiB: group.currentMiB, stall: group.stall } }),
      running: holders.length,
      waiting: turn.ahead?.length ?? 0,
    },
    state: {
      project: basename(host.projectRoot),
      cores,
      totalMiB: mem.totalMiB,
      swapTotalMiB: mem.swapTotalMiB,
      ...(floorMiB !== undefined && { floorMiB }),
      ...(group && {
        cgroup: {
          name: group.name,
          ...(group.highMiB !== undefined && { highMiB: group.highMiB }),
          ...(group.maxMiB !== undefined && { maxMiB: group.maxMiB }),
        },
      }),
      queue,
      owners: listed,
      more: {
        owners: rest.length,
        cpu: Math.round(rest.reduce((sum, owner) => sum + owner.cpu, 0) * 100) / 100,
        rssMiB: rest.reduce((sum, owner) => sum + owner.rssMiB, 0),
      },
      temp: places,
      pressure: pressureOf({
        load,
        cores,
        availableMiB: mem.availableMiB,
        ...(floorMiB !== undefined && { floorMiB }),
        temp: places,
        outside: (cpu.work ?? 0) + (cpu.automation ?? 0),
        stall,
        ...(group && { cgroup: group }),
      }),
    },
  }
}
