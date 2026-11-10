import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventToken } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { compareUrl } from '../../lib/compare.ts'
import { exec } from '../../lib/exec.ts'
import { fastForward, Refusal } from '../../lib/fast-forward.ts'
import type { Git } from '../../lib/fast-forward.ts'
import { installOwed, installPackages } from '../../lib/packages.ts'
import { githubRepo } from '../../lib/project-identity.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { PauseApi } from '../pause/api.ts'
import {
  cloneState,
  fetchIfDue,
  gitPath,
  layersOf,
  SUMMARY_SYSTEM,
  summaryFor,
  withLock,
} from './clone.ts'
import { Applied, CheckAction, MergeAction, Refused, StateAction, UpdateAction } from './refs.ts'
import type { UpdateResult, UpdateState } from './refs.ts'
import { UpdateApi } from './api.ts'
import { standingOf } from './item.ts'

/** How often the clone is compared with origin locally; origin itself is fetched at most hourly (`FETCH_EVERY`). */
export const TICK = 5 * 60_000

/** Git in `root`, never prompting: an HTTPS fetch without a login must fail rather than hang a background check. */
export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (await exec('git', args, { cwd: root, env, timeout: 120_000 })).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

/** Whether packages were installed after `startedAt` (ms): this server still runs the ones before. */
const installedSince = (root: string, startedAt: number) =>
  stat(join(root, 'node_modules/.pnpm/lock.yaml')).then(
    (info) => info.mtimeMs > startedAt,
    () => false,
  )

/**
 * Whether `server/` or `shared/` changed between `boot`, the commit this process started from, and the clone's HEAD:
 * the core still runs the old code, while extensions hot-reload against it.
 */
export async function coreChangedSince(git: Git, boot: string | undefined) {
  if (!boot) return false
  const files = await git('diff', '--name-only', boot, 'HEAD', '--', 'server', 'shared').catch(
    // An unknown boot commit or a broken clone: no evidence of a core change, so only installs ask for a restart.
    () => '',
  )
  return files !== ''
}

/** How long after an automatic restart no other one starts, across processes: a restart that does not help never loops. */
export const AUTO_RESTART_PAUSE = 10 * 60_000

/**
 * A listener for server facets that fail to load. When the running core is stale (`stale`: the core or packages changed
 * since boot, or the lockfile asks for packages it does not run, which holds every facet reload), the facet most likely
 * needs the new core, so it restarts the host at once, busy agents included: their work resumes in the new process.
 * A failure while the core is current is a real bug and stays a load error. Facets failing in one reload join the first
 * one's check, so they cause one restart; `last` (ms) keeps restarts apart.
 */
export function restartOnStaleLoad(options: {
  stale: () => Promise<boolean>
  restart: () => Promise<string>
  notice: (message: string) => void
  last: { read: () => Promise<number | undefined>; write: (at: number) => Promise<void> }
  pending: { current?: Promise<void> }
  now?: () => number
}) {
  const { stale, restart, notice, last, pending, now = Date.now } = options
  return (name: string) => {
    pending.current ??= (async () => {
      const at = await last.read()
      if (at !== undefined && now() - at < AUTO_RESTART_PAUSE) return
      if (!(await stale())) return
      await last.write(now())
      notice(`Restarting: ${name} failed to load after a core or package change`)
      notice(`Automatic restart failed: ${await restart()}`)
    })()
      .catch((error: unknown) => notice(`Automatic restart: ${String(error)}`))
      .finally(() => {
        pending.current = undefined
      })
  }
}

/** Whether an install is due: the lockfile differs from the installed packages, or the last install here failed. */
const installDue = async (host: ExtensionHost) =>
  state(host).failed || (await installOwed(host.ultimateRoot))

/**
 * Install the lockfile's packages when an install is due (pnpm can write the installed lockfile and still fail after
 * it); the install's last lines when it fails. A failure is remembered until an install succeeds. After a success, a
 * facet that still has a load error (it loaded while an install had failed, or is held since the lockfile moved) goes
 * to the stale-load listener: packages changed under this process, so it restarts.
 */
async function installNow(
  host: ExtensionHost,
): Promise<{ install: 'done' | 'failed' | 'skipped'; installError?: string }> {
  const shared = state(host)
  if (!(await installDue(host))) return { install: 'skipped' }
  const result = await installPackages(host.ultimateRoot, true)
  shared.failed = result.install === 'failed'
  if (shared.failed) return result
  const broken = host.extensions().find((extension) => extension.server?.error)?.name
  // Not awaited: its restart waits in `loadable` for the clone lock, which this install's update still holds.
  if (broken) shared.recover?.(broken)
  return result
}

/** How long a load waits for git to finish writing the checkout; a lock left by a crashed git must not block forever. */
const CHECKOUT_WAIT = 60_000
/** How long a load waits for another Ultimate's install on the clone: as long as an install may take. */
const INSTALL_WAIT = 10 * 60_000

/**
 * Settle once the clone at `host.ultimateRoot` can be loaded from: git is done writing its checkout (a fast-forward
 * holds `index.lock` until every file is written) and no Ultimate is installing packages into it (**Update now**, here
 * or in another Ultimate, installs under the clone-wide lock). Read from disk, never from an event, so every Ultimate
 * on the clone waits the same way whoever moved it: the lander, an update, another Ultimate, a pull by hand. Calls
 * while one runs join it.
 *
 * Origin: on 2026-11-09 three landings changed a patch (c16450c, 983ad97, e609be7). Extensions hot-reloaded while
 * `pnpm install` was still relinking the package and failed to load, which took the provider down with them.
 *
 * Upstream (1441b930) also installs owed packages here, and at once on `workspaces.landed`. This fork does not
 * (decided in #192186, 2026-11-10): after 3e61b579 nothing installs into a running core after a landing. Several
 * Ultimates share the clone's `node_modules`, a core keeps running the packages it loaded, its server facets are held
 * once the lockfile moved (`drifted` in `server/extensions.ts`), and the supervisor installs before it boots the next
 * core. Do not re-add the install or the reactor in a later merge.
 */
export function loadable(host: ExtensionHost): Promise<void> {
  const shared = state(host)
  const root = host.ultimateRoot
  shared.settling ??= (async () => {
    const index = await gitPath(gitIn(root), root, 'index.lock').catch(
      // Not a git checkout: nothing moves its files under us.
      () => undefined,
    )
    const deadline = Date.now() + CHECKOUT_WAIT
    if (index) while (existsSync(index) && Date.now() < deadline) await sleep(50)
    // Owed packages may be an install in progress: taking the clone-wide lock waits for whoever holds it.
    if (!(await installOwed(root))) return
    const free = await withLock(await lockOf(root), async () => true, INSTALL_WAIT)
    if (!free) throw new Error('Another Ultimate is still installing packages into this clone')
  })().finally(() => {
    shared.settling = undefined
  })
  return shared.settling
}

/** A preview started by another Ultimate's `instance` tool: it shares the clone and must never touch it. */
const preview = () => Boolean(process.env.ULTIMATE_INSTANCE_OWNER)

const previewState = (root: string): UpdateState => ({
  root,
  behind: 0,
  commits: [],
  install: false,
  restart: false,
  preview: true,
})

export default function update(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  host.need(SubagentsApi)
  host.want(PauseApi)
  host.implement(UpdateApi, { state: () => currentState(host) })
  const shared = state(host)
  // Read HEAD at load, before any landing or update can move it.
  boot(host)
  // A preview never fetches: it must not race the host on the same clone.
  if (preview()) return defineExtension({ name: 'update' })
  const lastFile = join(host.home, 'update-auto-restart.json')
  const pending = host.resource<{ current?: Promise<void> }>('update.auto-restart', () => ({}))
  const onLoadError = restartOnStaleLoad({
    stale: async () =>
      (await installedSince(host.ultimateRoot, Date.parse(host.system().process.startedAt))) ||
      (await installOwed(host.ultimateRoot)) ||
      (await coreChangedSince(gitIn(host.ultimateRoot), await boot(host).head)),
    // A successful restart never returns: this process is released and the new core resumes its work.
    restart: () => host.restart(async () => {}),
    notice: (message) => host.notice(message),
    last: {
      read: () =>
        readFile(lastFile, 'utf8').then(
          (text) => (JSON.parse(text) as { at: number }).at,
          // No automatic restart recorded yet.
          () => undefined,
        ),
      write: (at) => writeFile(lastFile, JSON.stringify({ at })),
    },
    pending,
  })
  host.onLoadError(onLoadError)
  shared.recover = onLoadError
  // Every extension reload, web build and restart waits for the checkout and an install in progress.
  host.onBeforeLoad(() => loadable(host))
  const tick = () => {
    // Paused: no fetch starts until Play; the next tick after it catches up.
    if (host.want(PauseApi)?.paused()) return
    shared.ticking ??= refresh(host, true)
      .catch((error: unknown) => host.notice(`Update check: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    await shared.ticking
    // Its failure was reported to whoever waited for it.
    await shared.settling?.catch(() => {})
  })
  return defineExtension({ name: 'update' })
}

type Shared = {
  ticking: Promise<void> | undefined
  checking: Promise<void> | undefined
  updating: Promise<UpdateResult> | undefined
  /** The current `loadable` wait; calls while it runs join it. */
  settling: Promise<void> | undefined
  /** The last install here failed; until one succeeds. */
  failed: boolean
  /** The current facet's stale-load listener, set on each load. */
  recover: ((name: string) => void) | undefined
  latest: UpdateState | undefined
  updated: (UpdateResult & { ok: true }) | undefined
}

/** Shared across reloads: a reload installs the new facet before the old one closes, and only one tick may run. */
const state = (host: ExtensionHost) =>
  host.resource<Shared>('update.state', () => ({
    ticking: undefined,
    checking: undefined,
    updating: undefined,
    settling: undefined,
    failed: false,
    recover: undefined,
    latest: undefined,
    updated: undefined,
  }))

/**
 * The clone's HEAD when this process first loaded the extension, read once: a resource outlives reloads, not the
 * process. Undefined when git fails (see `coreChangedSince`).
 */
const boot = (host: ExtensionHost) =>
  host.resource('update.boot-head', () => ({
    head: gitIn(host.ultimateRoot)('rev-parse', 'HEAD').catch(
      // Not a git checkout or git missing: restarts are then asked for installs only.
      () => undefined,
    ),
  }))

/** The clone-wide lock: fetches, updates and installs of one clone never overlap across the Ultimates on it. */
const lockOf = (root: string) => gitPath(gitIn(root), root, 'ultimate-update.lock')

/** Ask the summary model once with the range's commit messages; undefined without one. */
async function ask(host: ExtensionHost, input: string) {
  const conversations = host.need(ConversationsApi)
  const model = await conversations.summaryModel()
  if (!model) return undefined
  const response = await conversations.askSummaryModel(
    host.modelRuntime,
    SUMMARY_SYSTEM,
    input,
    AbortSignal.timeout(60_000),
    { model },
  )
  return response.stopReason === 'stop' ? response.text : undefined
}

/**
 * Compare the clone with origin and keep the result for `state`. A `check` fetches when due and summarizes a new
 * range (once per range, cached in the clone's git directory); `force` fetches even when not due; a plain refresh
 * only reads.
 */
async function refresh(host: ExtensionHost, check: boolean, force = false) {
  const shared = state(host)
  const root = host.ultimateRoot
  const git = gitIn(root)
  const summaryFile = await gitPath(git, root, 'ultimate-update-summary.json')
  /** The summary of the clone's current range; asks the model only with `asking`, else reads the cache. */
  const summarize = async (asking: boolean) => {
    const { head, remoteHead } = await cloneState(git, root)
    if (!remoteHead) return undefined
    return summaryFor(
      summaryFile,
      `${head}..${remoteHead}`,
      () => git('log', '--format=%s%n%n%b', `${head}..${remoteHead}`),
      asking ? (input) => ask(host, input) : undefined,
    )
  }
  // Under the clone's lock the fetch's age and the summary cache are read again, so the Ultimates on one clone fetch
  // and ask the summary model once between them.
  const checked = check
    ? await withLock(await lockOf(root), async () => {
        const error = await fetchIfDue(git, root, Date.now(), force)
        await summarize(true)
        return { error }
      })
    : undefined
  const error = checked ? checked.error : shared.latest?.error
  const clone = await cloneState(git, root)
  const repo = clone.remoteHead ? await githubRepo(root) : undefined
  const startedAt = Date.parse(host.system().process.startedAt)
  const { head, remoteHead, diverged, ...rest } = clone
  const summary = await summarize(false)
  // Checked for a diverged clone too: a merge must not be offered while the lander moves the same branch.
  const landingNow = rest.behind ? await landing(host) : undefined
  shared.latest = {
    root,
    head,
    ...rest,
    ...(summary ? { summary } : {}),
    refused: rest.refused ?? landingNow,
    ...(diverged && !landingNow && (await isProject(host)) ? { merge: true as const } : {}),
    ...(error ? { error } : {}),
    ...(repo && remoteHead ? { compare: compareUrl(repo, head, remoteHead) } : {}),
    install: await installDue(host),
    restart:
      (await installedSince(root, startedAt)) ||
      (await coreChangedSince(git, await boot(host).head)),
    ...(shared.updated ? { updated: shared.updated } : {}),
  }
  if (!shared.latest.refused) delete shared.latest.refused
}

/**
 * The clone's update state from the last check, read locally once when none was made yet; never fetches. Whether an
 * install is owed is read each time: a landing that changes the lockfile shows it at once, not at the next check.
 */
async function currentState(host: ExtensionHost) {
  const shared = state(host)
  if (preview()) return previewState(host.ultimateRoot)
  if (!shared.latest) await refresh(host, false)
  shared.latest!.install = await installDue(host)
  return shared.latest!
}

/**
 * Whether the clone is the project this Ultimate serves. Only then can a branch merge origin into it: the lander lands
 * a branch into the project's checkout, never into a separate clone Ultimate runs from.
 */
const isProject = async (host: ExtensionHost) =>
  (await realpath(host.ultimateRoot)) === (await realpath(host.projectRoot))

/** What @ultimate reads when the user asks it to merge origin into the diverged clone. */
const mergeInput = (branch: string, root: string, ahead: number, behind: number) =>
  [
    `Update with @ultimate: ${branch} in ${root} has diverged from origin/${branch} (${ahead} local ${ahead === 1 ? 'commit' : 'commits'}, ${behind} new upstream), so Update now can't fast-forward it.`,
    `Start a coordinator branch that merges origin/${branch} into ${branch} in its worktree: git fetch origin, then a normal git merge origin/${branch}, never a rebase, reset or force push.`,
    'It resolves the conflicts it can resolve safely, sends the unclear ones back as decisions, runs the checks and the tests covering the conflicts, and lands the merge with workspace submit.',
    'Afterwards the update item asks for any restart the upstream changes need.',
  ].join('\n')

/** Why an update must wait: the lander is landing into the clone (it fast-forwards the same branch). */
async function landing(host: ExtensionHost) {
  let index
  try {
    index = await host
      .harness()
      .snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, context)
  } catch {
    // Storage is closed (a core swap): nothing lands from this home meanwhile.
    return undefined
  }
  const root = await realpath(host.ultimateRoot)
  return index?.queue.some((entry) => entry.source === root && entry.state === 'landing')
    ? 'The lander is landing into this clone'
    : undefined
}

/** Commit one update event on its own: the clone lives outside storage. Only while storage is open. */
async function record<D extends JsonValue>(host: ExtensionHost, event: EventToken<D>, data: D) {
  try {
    await host.harness().commit((tx) => host.emit(tx, event, data), context)
  } catch (error) {
    // Storage is closed (a core swap) or the commit failed: the update itself stands, only its record is lost.
    host.notice(`Update event: ${String(error)}`)
  }
}

/**
 * Fast-forward the clone, install when the lockfile is owed (also with nothing to pull, so a failed install is retried),
 * and record what happened. Holds the clone-wide lock throughout.
 */
async function run(host: ExtensionHost): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const refuse = async (refused: string): Promise<UpdateResult> => {
    await record(host, Refused, { root, reason: refused })
    return { ok: false, refused }
  }
  const result = await withLock(await lockOf(root), () => apply(host, refuse))
  return result ?? refuse('Another Ultimate is updating this clone')
}

async function apply(
  host: ExtensionHost,
  refuse: (refused: string) => Promise<UpdateResult>,
): Promise<UpdateResult> {
  const root = host.ultimateRoot
  const git = gitIn(root)
  let moved
  try {
    // The landing check runs again right before the merge, after the fetch. A landing that starts after it is safe:
    // the lander fast-forwards only from the base it merged onto, sees the moved branch and retries.
    moved = await fastForward(git, undefined, () => landing(host))
  } catch (error) {
    if (error instanceof Refusal) return refuse(error.message)
    throw error
  }
  const files =
    moved.before === moved.after ? '' : await git('diff', '--name-only', moved.before, moved.after)
  const layers = layersOf(files.split('\n').filter(Boolean))
  // Owed while the lockfile differs from the installed one: a failed install is retried by the next update.
  const { install, installError } = await installNow(host)
  const result = {
    ok: true as const,
    from: moved.before.slice(0, 7),
    to: moved.after.slice(0, 7),
    commits: moved.behind,
    layers,
    install,
    ...(installError ? { installError } : {}),
  }
  if (moved.behind || install !== 'skipped') state(host).updated = result
  if (moved.behind) {
    await record(host, Applied, {
      root,
      from: moved.before,
      to: moved.after,
      commits: moved.behind,
      layers,
      install,
    })
  }
  return result
}

export const userActions = ['merge']

export const actions = {
  /** The clone's update state from the last check. */
  state: implementAction(StateAction, (_args, { host }) => currentState(host)),
  check: implementAction(CheckAction, async (_args, { host }) => {
    const shared = state(host)
    if (preview()) return previewState(host.ultimateRoot)
    // A background tick may be mid-check without forcing: let it finish, then fetch now. A second click joins.
    await shared.ticking
    shared.checking ??= refresh(host, true, true).finally(() => {
      shared.checking = undefined
    })
    await shared.checking
    return shared.latest!
  }),
  update: implementAction(UpdateAction, async (_args, { host }): Promise<UpdateResult> => {
    const shared = state(host)
    if (preview()) return { ok: false, refused: 'A preview never updates the clone it runs from' }
    // One update at a time: a second click joins the first.
    shared.updating ??= run(host).finally(() => {
      shared.updating = undefined
    })
    const result = await shared.updating
    await refresh(host, false)
    return result
  }),
  merge: implementAction(MergeAction, async (_args, { host }) => {
    if (preview()) throw new Error('A preview never updates the clone it runs from')
    await refresh(host, false)
    const latest = state(host).latest!
    const standing = standingOf(latest)
    if (standing.kind === 'preview' || standing.hold !== 'merge')
      throw new Error(latest.refused ?? `${latest.branch} has not diverged`)
    const { head, remoteHead } = await cloneState(gitIn(host.ultimateRoot), host.ultimateRoot)
    const id = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(id, context))!
    await conversation.submit(
      {
        type: 'input',
        content: mergeInput(latest.branch!, latest.root, latest.ahead ?? 0, latest.behind),
        // One ask per range: a second click while @ultimate is on it adds nothing.
        requestId: `update-merge:${head}..${remoteHead}`,
        whenBusy: 'followUp',
      },
      context,
    )
    return { id }
  }),
}
