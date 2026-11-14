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
 * `transferSeconds` getting the checkout there, `setupSeconds` preparing it there (dependencies), `cpuSeconds` the CPU
 * time the command used there. Otherwise why it did not: off, busy, lost half-way.
 */
export type RemoteStatus =
  | { ran: true; transferSeconds: number; setupSeconds: number; cpuSeconds: number }
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

/** Programs that only filter a command's output: allowed after a pipe. */
const FILTERS = new Set(['tail', 'head', 'grep', 'cut', 'sort', 'uniq', 'wc'])
/** A word that names something outside the checkout: an absolute path, the home folder or a parent folder. */
const OUTSIDE = /^~|(^|[=:,])\/|(^|\/)\.\.(\/|$)/

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
 * Whether the runner may run `command`, started in `cwd`: every pipeline starts with one of the project's `commands`
 * (whole words: `pnpm test` does not cover `pnpm test:e2e`), pipes only into output filters, and no word names anything
 * outside the checkout. A leading `cd <cwd> &&` is the checkout itself. Judged by its text on purpose: the other
 * machine has a copy of the checkout and nothing else of this one, so a command that names nothing else runs there as
 * it would here, and anything the grammar does not cover runs here.
 */
export function remoteEligible(command: string, cwd: string, commands: string[]) {
  const own = `cd ${cwd} && `
  const trimmed = command.trim()
  const pipelines = parse(trimmed.startsWith(own) ? trimmed.slice(own.length) : trimmed)
  if (!pipelines) return false
  const allowed = commands.map((entry) => entry.trim().split(/\s+/))
  return pipelines.every(
    ([first, ...filters]) =>
      allowed.some((words) => words.every((part, index) => first[index] === part)) &&
      filters.every((words) => FILTERS.has(words[0])) &&
      [first, ...filters].every((words) => !words.some((part) => OUTSIDE.test(part))),
  )
}

/** The status a runner left in `file`; undefined when it left none that reads as one. */
export async function readRemoteStatus(file: string): Promise<RemoteStatus | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (value.ran === false) return { ran: false, reason: text(value.reason) || 'no reason given' }
    const seconds = [value.transferSeconds, value.setupSeconds, value.cpuSeconds]
    if (value.ran !== true || !seconds.every((item) => Number.isFinite(item))) return undefined
    const [transferSeconds, setupSeconds, cpuSeconds] = seconds as number[]
    return { ran: true, transferSeconds, setupSeconds, cpuSeconds }
  } catch {
    // No file (the runner was stopped or crashed before writing it) or not JSON: no result either way.
    return undefined
  }
}
