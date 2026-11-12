/**
 * Who uses the machine: every process grouped by its process group, each group named in the user's terms (a project's
 * host, a queue job, a conversation's work outside the queue, a preview, a browser) by what it is and by the group that
 * started it. Pure: `server.ts` reads `/proc` and hands the processes in.
 */
import { basename } from 'node:path'
import type { Owner, OwnerKind } from './refs.ts'

/** One process from `/proc/<pid>/stat`, with its CPU over the last interval (cores). */
export type Proc = {
  pid: number
  ppid: number
  pgid: number
  /** Its program's name (`comm`). */
  name: string
  cpu: number
  rssKiB: number
  /** When it started (ms). */
  since: number
}
/**
 * What the topmost process of a group runs and where: read only for those. `command`: the program a background command
 * runs (`programOf` of its own text).
 */
export type Top = { argv: string[]; cwd?: string; command?: string }

export type OwnerContext = {
  /** Project homes (`~/.ultimate/projects/<name>-<hash>`) → the project's name, from their `project.json`. */
  homes: Map<string, string>
  /** Queue jobs that hold the slot, by their holder's pid: a background command leads its own group. */
  jobs: Map<number, { job: string; label: string; project?: string; conversation?: number }>
}

type Who = Omit<Owner, 'cpu' | 'rssMiB' | 'processes' | 'since' | 'key'>

const shells = /^(bash|sh|dash|zsh)$/
const interpreters = /^(node|python3?|bash|sh|dash|zsh)$/
/** Programs that run the program named after their options: `nice -n 15 …`, `timeout 30 …`, `nohup …`. */
const wrappers = /^(exec|nice|nohup|setsid|timeout)$/
/** Node options whose value is a file, not code. */
const fileOptions = /^(-r|--require|--import|--loader)$/
/** Node's long options that take no value as the next word; `--option=value` carries its value along. */
const valueless =
  /^--(experimental-(import-meta-resolve|strip-types|transform-types|vm-modules)|no-warnings|no-deprecation|enable-source-maps|expose-gc|trace-warnings|preserve-symlinks|inspect|watch)$/

/**
 * A short name for what `argv` runs, never an argument's value: the program, or for an interpreter the script file it
 * runs (`pnpm`, `vitest`, `chromium`), as a basename. It skips only words it knows the meaning of (assignments, a
 * wrapper's priority or timeout, an interpreter's file and listed valueless options); at any other word that could be a
 * value (`node -e …`, `env -u NAME`, `bash -o …`, a redirection) the program found so far names it. Review of #231847.
 */
export function programOf(argv: string[], name: string): string {
  let words = argv
  /** The program that runs the rest: what names it when the rest cannot be read safely. */
  let known = name
  for (;;) {
    // A command line may set variables before its program (`TOKEN=… pnpm test`); a redirection there (`> file`,
    // `<<- END`) has operands this does not read, so the program found so far names it.
    let start = 0
    while (start < words.length && /^[A-Za-z_]\w*=/.test(words[start])) start++
    if (start >= words.length || /^(\d*[<>]|&)/.test(words[start])) return known
    const program = basename(words[start])
    const rest = words.slice(start + 1)
    let next = 0
    if (wrappers.test(program)) {
      while (next < rest.length && (rest[next] === '-n' || /^\d+(\.\d+)?[smhd]?$/.test(rest[next])))
        next += rest[next] === '-n' ? 2 : 1
      if (rest[next]?.startsWith('-')) return program
      known = program
      words = rest.slice(next)
      continue
    }
    if (!interpreters.test(program)) return program || known
    let line: string | undefined
    while (line === undefined && next < rest.length && rest[next].startsWith('-')) {
      const option = rest[next]
      // A shell's `-c` (or `-lc`) runs a command line: what it runs is that line's program, after a `cd … &&`.
      // Other shell flags only from those that change nothing about what runs: -e -l -u -v -x.
      if (shells.test(program) && /^-[eluvx]*c[eluvx]*$/.test(option)) line = rest[next + 1] ?? ''
      // Node's options: a shell's or Python's `-r` means something else.
      else if (program === 'node' && fileOptions.test(option)) next += 2
      else if (program === 'node' && (valueless.test(option) || /^--[a-z][\w-]*=/.test(option))) {
        // `--eval=…` and `--print=…` carry code.
        if (/^--(eval|print)=/.test(option)) return program
        next++
      } else if (shells.test(program) && /^-[eluvx]+$/.test(option)) next++
      // Anything else may carry code or take a value (`-e`, `-m`, `--conditions x`, `bash -o x`).
      else return program
    }
    if (line !== undefined) {
      known = program
      // Split on whitespace only up to the first quote, escape or expansion: past it a word may be part of a quoted value
      // (`TOKEN="a b" curl`, `--require "a b.js"`, review of #231847).
      const quoted = line.search(/['"`\\$]/)
      words = (quoted < 0 ? line : line.slice(0, quoted))
        .replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      continue
    }
    const script = rest[next]
    return script && (script.includes('/') || /\.([cm]?[jt]s|py|sh)$/.test(script))
      ? basename(script).replace(/\.[cm]?js$/, '')
      : program
  }
}

/** The project home a folder lies in (`~/.ultimate/projects/<name>-<hash>`), and the path inside it. */
export function homeOf(cwd: string) {
  const found = /^(.*\/\.ultimate\/projects\/[^/]+)(?:\/(.*))?$/.exec(cwd)
  return found ? { home: found[1], inside: found[2] ?? '' } : undefined
}

/** The checkout a supervisor (`bin/ultimate.ts [project]`) serves: its argument, else its folder. */
function supervised(top: Top) {
  const at = top.argv.findIndex((word) => word.endsWith('bin/ultimate.ts'))
  if (at < 0) return undefined
  return top.argv.slice(at + 1).find((word) => !word.startsWith('-')) ?? top.cwd
}

type Places = { homes: Map<string, string>; roots: Map<string, string> }
/** The project and conversation a working directory belongs to: a worktree, a lander's folder, a checkout. */
function placeOf(cwd: string | undefined, places: Places) {
  if (!cwd) return undefined
  const found = homeOf(cwd)
  if (found) {
    // Without a readable `project.json`, the home's folder name without its hash.
    const project =
      places.homes.get(found.home) ?? basename(found.home).replace(/-[0-9a-f]{8}$/, '')
    const worktree = /^worktrees\/(\d+)(\/|$)/.exec(found.inside)?.[1]
    if (worktree) return { project, conversation: Number(worktree) }
    if (found.inside.startsWith('lander')) return { project, lander: true }
    return { project }
  }
  for (const [root, project] of places.roots)
    if (cwd === root || cwd.startsWith(`${root}/`)) return { project }
  return undefined
}

/** What a group is, from its topmost process and the owner of the group that started it. */
function classify(
  pgid: number,
  proc: Proc,
  top: Top,
  parent: Who | undefined,
  context: OwnerContext & Places,
): Who {
  const root = supervised(top)
  // The queue names a project by its checkout's folder: `#12 in my-app`.
  if (root) return { kind: 'host', project: basename(root), label: 'server' }
  const job = context.jobs.get(pgid)
  if (job) return { kind: 'job', ...job }
  // What a job, a preview, an automation or a conversation's command starts is theirs.
  if (parent && parent.kind !== 'host' && parent.kind !== 'system') return parent
  const place = placeOf(top.cwd, context)
  const where = {
    ...((place?.project ?? parent?.project) && { project: place?.project ?? parent?.project }),
    ...(place?.conversation !== undefined && { conversation: place.conversation }),
  }
  const command = top.argv.join(' ')
  if (/(^|\/)server\/main\.ts$/.test(top.argv.find((word) => word.endsWith('.ts')) ?? ''))
    return { kind: 'preview', ...where, label: 'preview' }
  if (/^(chromium|chrome|headless_shell)/.test(proc.name))
    return { kind: 'browser', ...where, label: 'chromium' }
  const automation = /\/\.ultimate\/automations\/[^/]*\/([^/]+)\//.exec(command)?.[1]
  if (automation) return { kind: 'automation', ...where, label: automation }
  const label = top.command ?? programOf(top.argv, proc.name)
  if (place?.lander) return { kind: 'lander', ...where, label }
  if (place || parent?.kind === 'host') return { kind: 'work', ...where, label }
  return { kind: 'system', label: proc.name }
}

const keyOf = (who: Who) =>
  who.job
    ? `job:${who.job}`
    : [
        who.kind,
        who.project ?? '',
        who.conversation ?? '',
        who.kind === 'system' ? who.label : '',
      ].join(':')

/**
 * Every process grouped by owner, largest CPU first, then memory. `tops` has the topmost process of each group (the
 * one whose parent is outside it); a group without one counts as system.
 */
export function owners(procs: Proc[], tops: Map<number, Top>, context: OwnerContext): Owner[] {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
  const groups = Map.groupBy(procs, (proc) => proc.pgid)
  const topOf = (members: Proc[]) =>
    members.find((proc) => byPid.get(proc.ppid)?.pgid !== proc.pgid) ?? members[0]
  // The checkouts the running hosts serve: work in one belongs to its project.
  const roots = new Map<string, string>()
  for (const top of tops.values()) {
    const root = supervised(top)
    if (root) roots.set(root, basename(root))
  }
  const places = { ...context, roots }
  const memo = new Map<number, Who>()
  const resolve = (pgid: number, seen: Set<number>): Who | undefined => {
    const known = memo.get(pgid)
    if (known) return known
    const members = groups.get(pgid)
    if (!members || seen.has(pgid)) return undefined
    seen.add(pgid)
    const top = topOf(members)
    const above = byPid.get(top.ppid)
    const parent = above ? resolve(above.pgid, seen) : undefined
    const who = classify(pgid, top, tops.get(top.pid) ?? { argv: [] }, parent, places)
    memo.set(pgid, who)
    return who
  }
  const owned = new Map<string, Owner>()
  const cpuOf = (members: Proc[]) => members.reduce((sum, proc) => sum + proc.cpu, 0)
  // Busiest group first: it names an owner made of several (a conversation's commands).
  for (const [pgid, members] of [...groups].toSorted(([, a], [, b]) => cpuOf(b) - cpuOf(a))) {
    const who = resolve(pgid, new Set())!
    const key = keyOf(who)
    const owner = owned.get(key) ?? {
      ...who,
      key,
      cpu: 0,
      rssMiB: 0,
      processes: 0,
      since: Infinity,
    }
    for (const proc of members) {
      owner.cpu += proc.cpu
      owner.rssMiB += proc.rssKiB / 1024
      owner.processes++
      owner.since = Math.min(owner.since, proc.since)
    }
    owned.set(key, owner)
  }
  return [...owned.values()]
    .map((owner) => ({
      ...owner,
      cpu: Math.round(owner.cpu * 100) / 100,
      rssMiB: Math.round(owner.rssMiB),
    }))
    .toSorted((a, b) => b.cpu - a.cpu || b.rssMiB - a.rssMiB)
}

/** CPU in use by owner kind, in cores. */
export function cpuByKind(list: Owner[]) {
  const sums: Partial<Record<OwnerKind, number>> = {}
  for (const owner of list) sums[owner.kind] = (sums[owner.kind] ?? 0) + owner.cpu
  for (const kind of Object.keys(sums) as OwnerKind[])
    sums[kind] = Math.round(sums[kind]! * 100) / 100
  return sums
}
