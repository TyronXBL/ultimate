/** Projects: lists this machine's Ultimate projects and starts a stopped or new one through its supervisor. */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { remotes } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ProjectInfo } from '../../server/project.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { ListAction, StartAction } from './refs.ts'
import type { LocalProject } from './refs.ts'

/**
 * How long a start waits for the child to report its project running, how much longer for its tailnet address while
 * this server publishes one, and how often it looks.
 */
const START_DEADLINE = 60_000
const TAILNET_GRACE = 15_000
const POLL = 500

type ListHost = Pick<ExtensionHost, 'want' | 'userHome' | 'projects'>
type StartHost = ListHost & Pick<ExtensionHost, 'projectRoot' | 'ultimateRoot' | 'resource'>

/**
 * Where the tailnet reaches each project root: this server's publication when its tailscale is ready, and the HTTPS
 * port that each project's own `tailscale` extension registered for its folder.
 */
async function tailnets(host: Pick<ExtensionHost, 'want' | 'userHome'>) {
  const published = host.want(TailscaleApi)?.status().url
  if (!published) return { byRoot: new Map<string, string>() }
  let registry: { ports?: Record<string, { port: number }> }
  try {
    registry = JSON.parse(await readFile(join(host.userHome, '.ultimate/tailscale.json'), 'utf8'))
  } catch {
    // Missing or unreadable, the registry names no address; the projects themselves still list and start.
    return { published, byRoot: new Map<string, string>() }
  }
  const { hostname } = new URL(published)
  return {
    published,
    byRoot: new Map(
      Object.entries(registry.ports ?? {}).map(([root, { port }]) => [
        root,
        `https://${hostname}:${port}`,
      ]),
    ),
  }
}

/** When anyone last wrote to one of a project's top-level conversations. */
function activeAt(conversations: ProjectInfo['conversations']) {
  return conversations.reduce<number | undefined>((latest, conversation) => {
    for (const at of [conversation.inputAt, conversation.answerAt])
      if (at !== undefined && (latest === undefined || at > latest)) latest = at
    return latest
  }, undefined)
}

/** A project as the switcher shows it; the tailnet address of the current one is this server's own. */
function listed(item: ProjectInfo, addresses: Awaited<ReturnType<typeof tailnets>>): LocalProject {
  const tailnet =
    item.current && addresses.published
      ? addresses.published
      : item.root
        ? addresses.byRoot.get(item.root)
        : undefined
  const active = activeAt(item.conversations)
  return {
    name: item.name,
    ...(item.root ? { root: item.root } : {}),
    current: item.current,
    ...(item.running ? { url: item.running.url } : {}),
    ...(item.running && tailnet ? { tailnet } : {}),
    ...(active !== undefined ? { activeAt: active } : {}),
  }
}

/** This machine's projects (this one first, then by name) and the user's remotes. */
export async function list(host: ListHost) {
  const addresses = await tailnets(host)
  const projects = (await host.projects()).map((item) => listed(item, addresses))
  return {
    projects: projects.toSorted(
      (a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name),
    ),
    remotes: await remotes(host),
  }
}

/** The starts in flight, by root, so that a second start of the same project waits for the first. */
const starts = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('projects.starts', () => new Map<string, Promise<LocalProject>>())

/** An absolute, existing folder: `~/` is the user's home and a relative path is refused. */
async function folder(host: Pick<ExtensionHost, 'userHome'>, value: unknown) {
  if (typeof value !== 'string' || value === '') throw new Error('Name the folder to open')
  const expanded = value.startsWith('~/') ? join(host.userHome, value.slice(2)) : value
  if (!isAbsolute(expanded)) throw new Error(`${value} is not an absolute path; use ~/ or /`)
  // A missing folder is the answer here; which path failed is in the message.
  const root = await realpath(expanded).catch(() => undefined)
  if (!root) throw new Error(`No folder at ${value}`)
  if (!(await stat(root)).isDirectory()) throw new Error(`${value} is not a folder`)
  return root
}

/**
 * The child's environment: none of this process's `ULTIMATE_*` identity, which would make it reuse the host's home,
 * port or generation instead of the project's own.
 */
const startEnv = (parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(parent).filter(([key]) => !key.startsWith('ULTIMATE_')))

/** What a start that failed reported: the tail of its log. */
async function logTail(path: string) {
  const lines = (await readFile(path, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-10)
  return lines.length ? lines.join('\n') : 'no output'
}

/** Start Ultimate in an already checked folder with its supervisor, and resolve once it lists as running. */
async function launch(host: StartHost, root: string): Promise<LocalProject> {
  const own = await realpath(host.projectRoot).catch(() => host.projectRoot)
  if (root === own) throw new Error('This is the project this Ultimate runs; open another folder')
  const addresses = await tailnets(host)
  const running = (await host.projects()).find((item) => item.root === root && item.running)
  if (running) return listed(running, addresses)
  const log = join(tmpdir(), `ultimate-projects-${basename(root)}-${process.pid}-${Date.now()}.log`)
  const output = await open(log, 'w')
  let child: ChildProcess
  try {
    child = spawn(
      process.execPath,
      [join(host.ultimateRoot, 'bin/ultimate.ts'), root, '--no-open'],
      {
        cwd: root,
        detached: true,
        stdio: ['ignore', output.fd, output.fd],
        env: startEnv(process.env),
      },
    )
  } catch (error) {
    await output.close()
    throw new Error(`Cannot start Ultimate in ${root}: ${String(error)}`, { cause: error })
  }
  await output.close()
  // The supervisor outlives this call and this server; its own log is in the project home once it runs.
  child.unref()
  const ended: { reason?: string } = {}
  child.on('exit', (code, signal) => {
    ended.reason ??= signal ?? `exited with code ${code}`
  })
  child.on('error', (error) => {
    ended.reason ??= String(error)
  })
  const deadline = Date.now() + START_DEADLINE
  let ran: number | undefined
  while (Date.now() < deadline) {
    if (ended.reason)
      throw new Error(
        `Ultimate in ${root} ${ended.reason} before it started:\n${await logTail(log)}`,
      )
    const started = (await host.projects()).find((project) => project.root === root)
    if (started?.running) {
      ran ??= Date.now()
      // A new folder registers its tailnet port a moment after it runs; without one it still opens on this machine.
      const now = await tailnets(host)
      if (!now.published || now.byRoot.has(root) || Date.now() - ran > TAILNET_GRACE)
        return listed(started, now)
    }
    await sleep(POLL)
  }
  throw new Error(
    `Ultimate in ${root} did not start within ${START_DEADLINE / 1000} seconds:\n${await logTail(log)}`,
  )
}

/** Start Ultimate in `root` (`~/` is the user's home), sharing a start already in flight for the same folder. */
export async function startProject(host: StartHost, root: unknown): Promise<LocalProject> {
  const path = await folder(host, root)
  const pending = starts(host)
  const shared = pending.get(path)
  if (shared) return shared
  const promise = launch(host, path)
  pending.set(path, promise)
  const settled = () => {
    pending.delete(path)
  }
  // Both outcomes settle the same way: the next start of this folder runs again.
  void promise.then(settled, settled)
  return promise
}

export default function projectsExtension(host: Pick<ExtensionHost, 'want'>) {
  // Tailscale is optional and resolved where it is called; declared here so the catalogue lists it.
  host.want(TailscaleApi)
  return defineExtension({ name: 'projects' })
}

export const actions = {
  list: implementAction(ListAction, (_args, { host }) => list(host)),
  start: implementAction(StartAction, async (args, { host }) => {
    const root = args && typeof args === 'object' && !Array.isArray(args) ? args.root : undefined
    return startProject(host, root)
  }),
}
