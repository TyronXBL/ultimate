import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import { bool, num, obj, opt, str } from '@earendil-works/pi-schema'
import type { Schema } from '@earendil-works/pi-schema'
import {
  type ConversationId,
  defineDoc,
  defineExtension,
  defineTool,
  LiveDoc,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable'
import {
  type BashExecution,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ReadToolInput,
} from '@earendil-works/pi-durable/tools'
import { FileError } from '@earendil-works/pi-durable/env'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { git } from '../../lib/git.ts'
import { commandNeedMiB, listUsers, memoryFloor, memoryUsers } from '../../lib/memory.ts'
import { describeWait, enterSlot, keepHeld, slotLabel, thisProcess } from '../../lib/slot.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { watchSteer } from '../../lib/steer.ts'
import { CancelAction, CancelledDoc, Committed } from './refs.ts'
import { listedSkills } from '../../lib/skills.ts'
import { atRevision } from './revision.ts'

/** Lets Pi's read tool shrink an image past the model's limits (2000x2000 by default) instead of refusing it. */
const images = await createNodePhotonImages()

/**
 * Pi's read tool, with `rev` to read a file as committed there. A missing `<name>/SKILL.md` names where the listed
 * skill of that name is, so an agent that guessed its folder finds it with the next read.
 */
function readTool(host: Pick<ExtensionHost, 'projectRoot' | 'skills'>) {
  const read = createReadTool({ images })
  const execute: typeof read.execute = async (args, api, context) => {
    try {
      return await read.execute(args, api, context)
    } catch (error) {
      const name = /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(args.path)?.[1]
      if (!(error instanceof FileError) || error.code !== 'not_found' || !name || !api.env)
        throw error
      const listed = listedSkills(host, api.env.cwd).find((skill) => skill.name === name)
      if (!listed) throw error
      throw new Error(`${error.message}. The skill "${name}" is at ${listed.filePath}.`, {
        cause: error,
      })
    }
  }
  // Pi's own read schema with one more optional property, so its fields and descriptions stay Pi's.
  const parameters: Schema<ReadToolInput & { rev?: string }> = {
    ...read.parameters,
    properties: {
      ...(read.parameters.properties as object),
      rev: str({
        description: 'Commit, branch or tag to read the file at, instead of the working tree',
      }),
    },
  }
  return defineTool({
    ...read,
    description: `${read.description} Pass rev (a commit, branch or tag) to read the file as of that commit instead of the working tree; a relative path resolves in the cwd's repository, whose commits every worktree shares.`,
    parameters,
    async execute({ rev, ...args }, api, context) {
      if (rev === undefined || !api.env) return execute(args, api, context)
      const env = await atRevision(api.env, args.path, rev, context)
      return execute(args, { ...api, env }, context)
    },
  })
}

function defaultBashTimeout() {
  const seconds = Number(process.env.ULTIMATE_BASH_TIMEOUT ?? 600)
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error('ULTIMATE_BASH_TIMEOUT must be a positive finite number of seconds')
  return seconds
}

const bashTripwireMessage = (seconds: number) =>
  `Tripwire: bash ran past the ${seconds} s default limit and was stopped. Pass timeout for longer commands.`

/** The signal behind an exit code of 128 + its number. This tool's own stops throw or exit 130, so these came from outside. */
const killedBy: Record<number, string> = { 137: 'SIGKILL', 143: 'SIGTERM' }

/** `result`, with a note when its exit code says a process was killed from outside the call. */
function killedHint(result: ToolExecutionResult): ToolExecutionResult {
  const exitCode = (result.structuredOutput as { exitCode?: number } | undefined)?.exitCode
  const signal = exitCode === undefined ? undefined : killedBy[exitCode]
  if (!signal) return result
  const example =
    signal === 'SIGKILL'
      ? 'kill -9, or the out-of-memory killer'
      : 'a `pkill -f` whose pattern also matches this command line'
  const message = `Exit code ${exitCode}: a process got ${signal} from outside this call, not from its timeout (for example ${example}).`
  return {
    ...result,
    diagnostics: [...(result.diagnostics ?? []), { severity: 'info', code: 'killed', message }],
  }
}

/**
 * Process-local Git hooks for one bash call. Each appends tab-separated lines (kind, sha, branch, worktree, git common
 * dir, extra) to `$ULTIMATE_COMMIT_LOG` and swallows every failure, so it can never fail a commit; the trailing `#`
 * drops the arguments Git appends.
 */
const where = `"$(git symbolic-ref -q --short HEAD)" "$(git rev-parse --show-toplevel)" "$(git rev-parse --path-format=absolute --git-common-dir)"`
const logCommit = `printf 'commit\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${where} 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`
const hooks = (conversation: number) => ({
  'prepare-commit-msg': `git interpret-trailers --in-place --if-exists doNothing --trailer "Ultimate-Conversation: ${conversation}" "$1" #`,
  'post-commit': logCommit,
  // `git am` and the apply backend of rebase make commits without post-commit.
  'post-applypatch': logCommit,
  // Merges run no post-commit. Fast-forwards and squashes run post-merge too, so it also logs the HEAD before the
  // merge and the reflog's subject (`… Fast-forward` for one).
  'post-merge': `printf 'merge\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(git rev-parse HEAD)" ${where} "$(git rev-parse -q --verify ORIG_HEAD)" "$(git reflog -1 --format=%gs)" 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
  // Git's stdin holds `old new` pairs of amended or rebased commits.
  'post-rewrite': `while read -r old new rest; do printf 'rewrite\\t%s\\t\\t\\t%s\\t%s\\n' "$new" "$(git rev-parse --path-format=absolute --git-common-dir)" "$old"; done 2>/dev/null >> "$ULTIMATE_COMMIT_LOG" || true #`,
})

/** Install the hooks for bash call `api` in `execution`; they log its commits to `log` when given. */
export function prepareBash(
  execution: BashExecution,
  api: Pick<ToolExecutionApi, 'conversationId'>,
  log?: string,
) {
  let count = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  for (const [event, command] of Object.entries(hooks(api.conversationId))) {
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.event`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = event
    execution.env[`GIT_CONFIG_KEY_${count}`] = `hook.ultimate-${event}.command`
    execution.env[`GIT_CONFIG_VALUE_${count++}`] = command
  }
  execution.env.GIT_CONFIG_COUNT = String(count)
  execution.env.NO_COLOR = '1'
  execution.env.FORCE_COLOR = '0'
  if (log) execution.env.ULTIMATE_COMMIT_LOG = log
}

/** Why a command marked `interruptible` must not be cut mid-way, if it changes something; `undefined` when it only waits. */
export function changes(command: string) {
  // Bash joins backslash-newline continuations before it runs a line.
  const joined = command.replaceAll('\\\n', ' ')
  const end = '(?=$|[\\s;&|)])'
  return (
    new RegExp(`\\bgit\\s+(?:-C\\s+\\S+\\s+|-\\S+\\s+)*(push|commit|merge)${end}`).exec(
      joined,
    )?.[1] ??
    // A word of its own (npm install, composer install, artisan migrate:fresh), not part of a path or file name.
    new RegExp(`(?:^|[\\s;&|(])(install|migrate)(?=$|[\\s;&|):])`).exec(joined)?.[1]
  )
}

/**
 * Hints for a command that works but has a dedicated path: a leading `cd` into the directory bash already starts in,
 * or one file read with `cat`, `head` or `sed -n`, which the read tool does. Only plain single commands count: pipes,
 * lists, redirects, substitutions, globs and several files are legitimate shell work, and `tail` has no read equivalent.
 */
export function bashHints(command: string, cwd: string) {
  const hints: string[] = []
  const cd = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;|\n)/.exec(command)
  const target = cd?.[1].replace(/^(["'])(.*)\1$/, '$2').replace(/^~(?=\/|$)/, homedir())
  const own = target !== undefined && resolve(cwd, target) === resolve(cwd)
  if (own) hints.push(`bash already starts in ${resolve(cwd)}; leave out the leading cd.`)
  const rest = (own ? command.slice(cd![0].length) : command).trim()
  const file = String.raw`\s+[^\s-]\S*$`
  const read = new RegExp(
    String.raw`^(cat)(\s+-n)?${file}|^(head)(\s+-(n\s*)?\d+)?${file}|^(sed)\s+-n\s+(['"]?)\d+(,\d+)?p\7${file}`,
  ).exec(rest)
  // Pipes, lists, redirects, substitutions and globs make it shell work, not a read.
  if (read && !/[|;&<>`$()\\*?\n]/.test(rest))
    hints.push(
      `Read files with the read tool (offset and limit for a range), not ${read[1] ?? read[3] ?? read[6]}.`,
    )
  return hints
}

/**
 * The bash calls the user cancelled (`CancelAction`), by call id → when. Durable, so a call started before an extension
 * reload sees a cancel made after it. A restart ends a running call anyway: Pi recovers it as interrupted.
 */
const Cancelled = defineDoc<{ calls: Record<string, number> }>({
  kind: CancelledDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ calls: {} }),
})
export const docs = [Cancelled]

/** `40s`, `5m 09s`, `2h 05m`. */
function took(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

/**
 * Run `run` until it finishes or is stopped, whichever comes first: by the user's cancel of this call, or, when
 * `interruptible`, by a steer queued in its conversation. A steer joins a run only after the tool round, so a wait would
 * otherwise hold it; ending the command here lets the run go on and the steer be placed at once. Follow-ups wait for the
 * run's end anyway, so they never interrupt. A stopped command is killed, and the call ends with the output so far and a
 * notice, as an ordinary result.
 */
async function untilStopped(
  run: (context: Context) => Promise<ToolExecutionResult>,
  api: ToolExecutionApi,
  interruptible: boolean | undefined,
  context: Context,
): Promise<ToolExecutionResult> {
  const id = api.conversationId
  // A watch needs the document to exist; created once per conversation.
  if (!(await api.snapshot(Cancelled, id, context)))
    await api.commit((tx) => tx.doc(Cancelled, id), context)
  const cancelled = (await api.watchDoc(Cancelled, id, context))!
  const started = performance.now()
  const { context: command, cancel } = withCancel(context)
  let reason: string | undefined
  const stop = (why: string) => {
    if (reason) return
    reason = why
    cancel(new Error(why))
  }
  const inspectCancelled = (value: typeof cancelled.value) => {
    if (value?.calls[api.callId] !== undefined) stop('Cancelled by the user')
  }
  cancelled.start(async (call) => {
    if (call.kind === 'value') inspectCancelled(call.value)
  })
  const stopSteer = interruptible
    ? await watchSteer(api, context, () => stop('Interrupted by a steering message'))
    : undefined
  try {
    inspectCancelled(cancelled.value)
    return await run(command)
  } catch (error) {
    if (!reason || context.abortSignal?.aborted) throw error
    const retained = api.retainedOutput()
    // The notice goes last: long output keeps its tail, so a leading notice would be cut.
    return {
      output: [
        {
          type: 'text',
          text: `${retained.text || '(no output)'}\n[${reason} after ${took(performance.now() - started)}; the output above is the last the command printed.]`,
        },
      ],
      structuredOutput: { output: retained.text, truncated: retained.truncated, exitCode: 130 },
    }
  } finally {
    await Promise.all([cancelled.stop(), stopSteer?.()])
  }
}

export const userActions = ['cancel']
export const actions = {
  cancel: implementAction(CancelAction, async (args, { host, conversationId }) => {
    const callId =
      args && typeof args === 'object' && !Array.isArray(args) ? args.callId : undefined
    if (typeof callId !== 'string' || conversationId === undefined)
      throw new Error('Invalid bash call')
    const id = conversationId as ConversationId
    await host.harness().commit(async (tx) => {
      const live = await tx.doc(LiveDoc, id)
      const running = new Set(
        [...(live.tools ?? []), ...(live.nestedTools ?? [])].flatMap((slot) =>
          slot.name === 'bash' && slot.status === 'running' ? [slot.callId] : [],
        ),
      )
      if (!running.has(callId)) throw new Error('That bash call is not running')
      const calls = (await tx.doc(Cancelled, id)).calls
      // Calls never remove their own marks (one could land as a call ends); each cancel drops those of ended calls.
      for (const ended of Object.keys(calls)) if (!running.has(ended)) delete calls[ended]
      calls[callId] = Date.now()
    }, BACKGROUND_CONTEXT)
    return null
  }),
}

type Made = {
  sha: string
  branch?: string
  toplevel: string
  common: string
  rewrittenFrom?: string
}

/**
 * The commits a bash call made, from its hook log at `path`, which this removes. Only a commit line, or a post-merge
 * line for a real merge commit (first parent the HEAD before it, not a fast-forward), records a commit; a rewrite line
 * only adds `rewrittenFrom` to one, since a resumed rebase also lists commits an earlier call made.
 */
async function madeCommits(path: string, conversation: number) {
  const log = await readFile(path, 'utf8').catch(() => '')
  await rm(path, { force: true })
  const made = new Map<string, Made>()
  const merges = new Map<string, string>()
  const rewrites: string[][] = []
  for (const line of log.split('\n')) {
    const [kind, sha, branch, toplevel, common, extra, reflog] = line.split('\t')
    if (!sha || !common) continue
    if (kind === 'rewrite') rewrites.push([sha, extra])
    else if (kind === 'merge' && reflog?.endsWith(': Fast-forward')) continue
    else if ((kind === 'commit' || kind === 'merge') && !made.has(sha)) {
      made.set(sha, { sha, ...(branch ? { branch } : {}), toplevel, common })
      if (kind === 'merge') merges.set(sha, extra ?? '')
    }
  }
  for (const [sha, old] of rewrites) {
    const commit = made.get(sha)
    if (commit && old) commit.rewrittenFrom = old
  }
  const byRepo = Map.groupBy(made.values(), (commit) => commit.common)
  const events = []
  for (const [common, commits] of byRepo) {
    // The commits stay readable from the repository after their worktree is gone.
    const shown = await git(
      common,
      'log',
      '--no-walk=unsorted',
      '--format=%H%x00%P%x00%s%x1e',
      ...commits.map((commit) => commit.sha),
    ).catch(() => '')
    const details = new Map(
      shown
        .split('\x1e')
        .map((record) => record.trim().split('\0'))
        .map(([sha, parents, subject]) => [sha, { parents, subject }]),
    )
    for (const commit of commits) {
      const found = details.get(commit.sha)
      if (!found) continue
      const parents = found.parents ? found.parents.split(' ') : []
      // A squash leaves HEAD where it was, which is no merge commit on the HEAD before it.
      const before = merges.get(commit.sha)
      if (before !== undefined && !(parents.length > 1 && parents[0] === before)) continue
      const repo = basename(common) === '.git' ? dirname(common) : common
      events.push({
        conversation,
        sha: commit.sha,
        parents,
        repo,
        ...(commit.toplevel && commit.toplevel !== repo ? { worktree: commit.toplevel } : {}),
        ...(commit.branch ? { branch: commit.branch } : {}),
        subject: found.subject,
        ...(commit.rewrittenFrom ? { rewrittenFrom: commit.rewrittenFrom } : {}),
      })
    }
  }
  return events
}

export default function codingTools(
  host: Pick<ExtensionHost, 'emit' | 'projectRoot' | 'skills' | 'userHome'>,
) {
  const shell = createBashTool()
  const parameters = obj({
    command: str({ description: 'Bash command to execute' }),
    timeout: opt(
      num({
        description:
          'Timeout in seconds (optional; without it a default tripwire, 600 s unless configured, stops the command)',
      }),
    ),
    interruptible: opt(
      bool({
        description:
          'Only for commands that just wait or poll (CI checks, deploys, a file appearing): a steering message ends the command early. Never combine with commands that change things.',
      }),
    ),
  })
  // In the tool itself, not a wrap, so the events carry the call's trace and conversation.
  const bashTool = defineTool({
    ...shell,
    parameters,
    async execute({ interruptible, ...args }, api, context) {
      const change = interruptible ? changes(args.command) : undefined
      if (change)
        throw new Error(
          `An interruptible command must only wait, but this one changes things (${change}). Run the change in its own bash call, then wait in a separate interruptible one.`,
        )
      if (api.env)
        for (const message of bashHints(args.command, api.env.cwd))
          api.diagnostic({ severity: 'info', code: 'bash_hint', message })
      // One log per invocation: task ids repeat across projects and a retried call reruns its task.
      const log = join(tmpdir(), `ultimate-commits-${randomUUID()}.log`)
      const call = createBashTool({
        prepare: (execution) => prepareBash(execution, api, log),
      })
      const run = (command: Context) => call.execute(args, api, command)
      // A known heavy command (tests, checks, installs, a server) runs here only while the machine's heavy-work slot is
      // free, nobody waits for it and RAM allows, decided under the queue's lock; it holds the slot while it runs.
      const need = commandNeedMiB(args.command)
      let release: (() => Promise<void>) | undefined
      if (need) {
        const claim = {
          id: `${host.projectRoot}:bash:${randomUUID()}`,
          at: Date.now(),
          label: slotLabel(args.command),
          from: `#${api.conversationId} in ${basename(host.projectRoot)} (bash)`,
        }
        const entered = await enterSlot(claim, {
          floor: await memoryFloor(host.userHome),
          need,
          start: thisProcess,
          queue: false,
        })
        if (entered.kind !== 'started')
          throw new Error(
            `Not run: a heavy command runs in bash only while the heavy-work slot is free, nobody waits for it and RAM allows. It would be ${describeWait(entered)}. Queue it instead with exactly this call; it starts by itself in order and its result steers or wakes you, so never sleep, poll or retry it in bash:\nbackground ${JSON.stringify({ command: args.command })}${entered.kind === 'ram' ? `\nWhat this Ultimate runs, by RSS:\n${listUsers(await memoryUsers())}` : ''}`,
          )
        // Held from here: the `finally` below lets it go however the command ends.
        release = keepHeld(claim)
      }
      try {
        return await untilStopped(run, api, interruptible, context)
      } finally {
        await release?.()
        // A failed or stopped command may still have committed, so record what it made either way.
        const commits = await madeCommits(log, api.conversationId)
        if (commits.length)
          await api
            .commit(async (tx) => {
              for (const commit of commits) await host.emit(tx, Committed, commit)
            }, context)
            .catch((error: unknown) =>
              // Recording is history only; the command's own result must stand.
              console.error('coding-tools: recording commits failed:', error),
            )
      }
    },
  })
  return defineExtension({
    name: 'coding-tools',
    // Each tool keeps its own parameters; the list is only read through the base registration.
    tools: [readTool(host), createWriteTool(), createEditTool(), bashTool] as ToolRegistration[],
    wraps: [
      wrapTool(createBashTool(), (bash) => ({
        ...bash,
        async execute(args, api, context) {
          if (args.timeout !== undefined) return killedHint(await bash.execute(args, api, context))
          const timeout = defaultBashTimeout()
          try {
            return killedHint(await bash.execute({ ...args, timeout }, api, context))
          } catch (error) {
            if (
              error instanceof Error &&
              /^Command timed out after [\d.e+-]+ seconds$/.test(error.message)
            )
              throw new Error(bashTripwireMessage(timeout), { cause: error })
            throw error
          }
        },
      })),
    ],
  })
}
