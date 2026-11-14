/**
 * Remote jobs: a project may run some of its background commands on another machine first, so this one keeps its CPU
 * (#281756: the host is a small server, a faster PC on the tailnet sits idle). Two settings turn it on together:
 * `remoteJobs.host` in `~/.ultimate/settings.json` names the machine (this machine's switch), and `remoteJobs` in the
 * trusted project's `.ultimate/settings.json` names the project's `runner` and the `commands` it may run there. The
 * runner is the project's own program: how the checkout gets there and how the command runs is its business. It runs
 * here as a light process in the job's folder, with `REMOTE_ENV` set, and says in a status file whether the command
 * ran (`RemoteStatus`). Anything but "it ran" (no file, a runner that crashed or was lost) is no result, and the command
 * runs here: this machine never depends on the other one.
 */
import { readFile } from 'node:fs/promises'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, userSettingsPath } from './settings.ts'

/** The environment a runner reads: the machine to run on, the command, and the file its status goes to. */
export const REMOTE_ENV = {
  host: 'ULTIMATE_REMOTE_HOST',
  command: 'ULTIMATE_REMOTE_COMMAND',
  status: 'ULTIMATE_REMOTE_STATUS',
} as const

/** A project's remote runner on this machine: the host, the runner's command line and the invocations it may run. */
export type RemoteRunner = { host: string; runner: string; commands: string[] }

/**
 * What a runner says before it exits. `ran`: the command ran there and the runner exited with its exit code;
 * `transferSeconds` getting the checkout there, `setupSeconds` preparing it there (dependencies), `runSeconds` the
 * command itself and `cpuSeconds` the CPU time it used there. Otherwise why it did not: off, busy, lost half-way.
 */
export type RemoteStatus =
  | {
      ran: true
      transferSeconds: number
      setupSeconds: number
      runSeconds: number
      cpuSeconds: number
    }
  | { ran: false; reason: string }

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '')

/**
 * This machine's runner for the project whose trusted settings are `project`, or undefined when either side names
 * none. Read at every use, so a change applies to the next command.
 */
export async function remoteRunner(
  userHome: string,
  project: JsonObject,
): Promise<RemoteRunner | undefined> {
  const user = await readSettings(userSettingsPath(userHome)).catch(
    // Unreadable settings: the setup status reports them; without a host nothing runs remotely.
    (): JsonObject => ({}),
  )
  const host = text((user.remoteJobs as JsonObject | undefined)?.host)
  const { runner, commands } = (project.remoteJobs ?? {}) as JsonObject
  const listed = Array.isArray(commands) ? commands.map(text).filter(Boolean) : []
  return host && text(runner) && listed.length
    ? { host, runner: text(runner), commands: listed }
    : undefined
}

const count = /^[-+]?\d+$/
/**
 * Programs that only filter a command's output, allowed after a pipe, each with the arguments that keep it one: it
 * reads its input from the pipe and nothing else, and writes nowhere. So no file operand, no option that names a file
 * (`grep -f`, `sort -o`) or a program, and `sort`, `uniq` and `cut` are left out rather than have their options listed.
 */
const FILTERS: Record<string, (args: string[]) => boolean> = {
  tail: (args) => args.every((arg) => /^-[nc]$|^-[nc][-+]?\d+$/.test(arg) || count.test(arg)),
  head: (args) => FILTERS.tail(args),
  wc: (args) => args.every((arg) => /^-[lwcm]+$/.test(arg)),
  // Flags, context and count options with their number, and patterns: one bare, or each after `-e`.
  grep(args) {
    let patterns = 0
    let named = false
    for (let at = 0; at < args.length; at++) {
      const arg = args[at]
      if (/^-[EFGPivcnqwxoah]+$/.test(arg) || /^-[ABCm]\d+$/.test(arg)) continue
      if (/^-[ABCm]$/.test(arg) && /^\d+$/.test(args[at + 1] ?? '')) at++
      else if (arg === '-e' && at + 1 < args.length) {
        named = true
        at++
      } else if (!arg.startsWith('-')) patterns++
      else return false
    }
    return named ? patterns === 0 : patterns === 1
  },
}
/** A value that names something outside the checkout: an absolute path, the home folder or a parent folder. */
const OUTSIDE = /^~|(^|[=:,])\/|(^|\/)\.\.(\/|$)/
/** Whether `word` names something outside the checkout, also as the value attached to a short option (`-c/etc/x`). */
const outside = (word: string) =>
  OUTSIDE.test(word) || (/^-[^-]/.test(word) && OUTSIDE.test(word.slice(2)))

/**
 * `command` as pipelines of stages of words, quotes removed; undefined when it uses shell the grammar leaves out. The
 * grammar is what a copy of the checkout runs the same way: words, quotes without expansion, `&&`, `||`, `;`, pipes and
 * `2>&1`. No variable, substitution, redirect, group, escape, comment, background `&` or line break.
 */
function parse(command: string) {
  const pipelines: string[][][] = [[[]]]
  let word: string | undefined
  const stage = () => pipelines.at(-1)!.at(-1)!
  const end = () => {
    if (word !== undefined) stage().push(word)
    word = undefined
  }
  for (let at = 0; at < command.length; at++) {
    const char = command[at]
    const two = command.slice(at, at + 2)
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, at + 1)
      if (close < 0) return undefined
      const quoted = command.slice(at + 1, close)
      // Double quotes still expand these; single quotes expand nothing.
      if (char === '"' && /[$`\\]/.test(quoted)) return undefined
      word = (word ?? '') + quoted
      at = close
    } else if (char === ' ' || char === '\t') end()
    else if (word === undefined && command.startsWith('2>&1', at)) at += 3
    else if (two === '&&' || two === '||' || char === ';') {
      end()
      pipelines.push([[]])
      if (char !== ';') at++
    } else if (char === '|') {
      end()
      pipelines.at(-1)!.push([])
    } else if ('$`(){}<>&\\\n#'.includes(char)) return undefined
    else word = (word ?? '') + char
  }
  end()
  return pipelines
}

/**
 * `command`, started in `cwd`, as the runner may run it in its copy of the checkout, or undefined when it may not:
 * every pipeline starts with one of the project's `commands` (whole words: `pnpm test` does not cover
 * `pnpm test:e2e`), pipes only into output filters, and no word names anything outside the checkout. A leading
 * `cd <cwd> &&` is the checkout itself and is left out: the copy lives somewhere else. Judged by its text on purpose:
 * the other machine has a copy of the checkout and nothing else of this one, so a command that names nothing else runs
 * there as it would here, and anything the grammar does not cover runs here.
 */
export function remoteCommand(command: string, cwd: string, commands: string[]) {
  const own = `cd ${cwd} && `
  const trimmed = command.trim()
  const there = trimmed.startsWith(own) ? trimmed.slice(own.length) : trimmed
  const pipelines = parse(there)
  if (!pipelines) return undefined
  const allowed = commands.map((entry) => entry.trim().split(/\s+/))
  const ok = pipelines.every(
    ([first, ...filters]) =>
      allowed.some((words) => words.every((part, index) => first[index] === part)) &&
      filters.every(([program, ...args]) => FILTERS[program]?.(args)) &&
      [first, ...filters].every((words) => !words.some(outside)),
  )
  return ok ? there : undefined
}

/** The status a runner left in `file`; undefined when it left none that reads as one. */
export async function readRemoteStatus(file: string): Promise<RemoteStatus | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (value.ran === false) return { ran: false, reason: text(value.reason) || 'no reason given' }
    const seconds = [value.transferSeconds, value.setupSeconds, value.runSeconds, value.cpuSeconds]
    if (value.ran !== true || !seconds.every((item) => Number.isFinite(item))) return undefined
    const [transferSeconds, setupSeconds, runSeconds, cpuSeconds] = seconds as number[]
    return { ran: true, transferSeconds, setupSeconds, runSeconds, cpuSeconds }
  } catch {
    // No file (the runner was stopped or crashed before writing it) or not JSON: no result either way.
    return undefined
  }
}
