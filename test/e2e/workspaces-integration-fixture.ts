import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { cp, mkdir, writeFile, access, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { obj } from '@earendil-works/pi-schema'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import type { ConversationId, JsonObject } from '@earendil-works/pi-durable'
import { afterAll, expect, vi } from 'vitest'
import { context, prepareHarness } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import { eventLog } from '../../server/events.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ActionContext } from '../../server/actions.ts'
import workspaceExtension, { actions } from '../../extensions/workspaces/server.ts'
import { Workspaces, workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../lib/git.ts'
import type { LanderEntry, WorkspaceIndex } from '../../extensions/workspaces/types.ts'
import type { ConversationsService } from '../../extensions/conversations/api.ts'
import { setAutomaticSummaries } from '../../extensions/conversations/summary.ts'
import { setStanding } from '../../extensions/conversations/server.ts'
import self from '../../extensions/self/server.ts'
import messagesExtension from '../../extensions/messages/server.ts'
import { Messages } from '../../extensions/messages/api.ts'
import subagents from '../../extensions/subagents/server.ts'
import { ModelsApi } from '../../extensions/models/api.ts'
import { modelsService } from '../../extensions/models/set-model.ts'
import { temp, until } from '../helpers.ts'

/**
 * The part of the conversations service a test stands in for; standing a lander turns its summaries off and marks it
 * standing, and no conversation tree is concluded unless a test says so.
 */
export const conversations = (service: Partial<ConversationsService>) =>
  ({
    setAutomaticSummaries,
    setStanding,
    concludedTreeIn: async () => false,
    ...service,
  }) as ConversationsService

// Every test has its own repository and harness, so they all run concurrently; fixtures close when the file ends.
vi.setConfig({ maxConcurrency: 16 })
const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})
/** A repository with base.txt and a worktree `worker` definition, made once and copied for each test. */
let template: Promise<string> | undefined
export async function repository() {
  template ??= (async () => {
    const path = join(await temp('ultimate-workspaces-template-'), 'project')
    await mkdir(join(path, 'agents'), { recursive: true })
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'user.email', 'test@example.com')
    await git(path, 'config', 'user.name', 'Test')
    await writeFile(join(path, 'base.txt'), 'base')
    await writeFile(
      join(path, 'agents/worker.md'),
      '---\nname: worker\ndescription: Writes\nisolate: worktree\n---\nCommit the assigned change.\n',
    )
    await git(path, 'add', '.')
    await git(path, 'commit', '-m', 'base')
    return path
  })()
  const directory = await temp('ultimate-workspaces-')
  const projectRoot = join(directory, 'project')
  await cp(await template, projectRoot, { recursive: true })
  return { directory, projectRoot, home: join(directory, 'state') }
}
export async function fixture(
  commands: string[] = [],
  existing?: Awaited<ReturnType<typeof repository>>,
  messagesEnabled = false,
) {
  const paths = existing ?? (await repository())
  const prepared = await prepareHarness({
    ...paths,
    userHome: paths.directory,
    ultimateRoot: paths.projectRoot,
    faux: fauxProvider(),
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const services = new Map<string, unknown>()
  const restart = vi.fn<ExtensionHost['restart']>(async () => 'RESTART_CALLED')
  const notice = vi.fn<ExtensionHost['notice']>()
  // As the server: openers run each time the harness opens, cleanups each time it closes.
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  const lookup = ({ name }: { name: string }) => services.get(name)
  // As the server: the real event log, and reactors that run while the harness is open.
  const events = eventLog(
    () => opened.harness,
    (_call, work) => work(),
  )
  let started = false
  const host = {
    ...prepared,
    harness: () => opened.harness,
    metadata: Metadata,
    emit: events.emit,
    eventLog: events.eventLog,
    react: (...[name, tokens, handler]: Parameters<typeof events.reactor>) => {
      const reactor = events.reactor(name, tokens, handler)
      openers.push(reactor.start)
      closers.push(reactor.stop)
      // oxlint-disable-next-line typescript/no-floating-promises -- reactor start waits for its drain chain, which records handler failures rather than rejecting.
      if (started) void reactor.start()
    },
    implement: (api: { name: string }, value: unknown) => {
      services.set(api.name, value)
    },
    want: lookup,
    need: (api: { name: string }) =>
      new Proxy({}, { get: (_, key) => (lookup(api) as Record<string | symbol, unknown>)?.[key] }),
    projectSettings: async () => ({ isolates: { worktree: { setup: commands } } }),
    projectSetup: async () => ({ config: false, decision: true }),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    restart,
    notice,
    onOpen: (callback: () => Promise<void>) => openers.push(callback),
    onClose: (close: () => Promise<void>) => closers.push(close),
    doc: () => undefined,
    conversations: () => [],
    build: () => ({ id: 'test-build' }),
    system: () => ({ process: {} }),
  } as unknown as ExtensionHost
  services.set(ModelsApi.name, modelsService(prepared))
  // The core's conversations, until a test implements its own: nothing concluded, no titles or summaries.
  services.set(
    'conversations',
    conversations({
      concluded: async () => new Set<ConversationId>(),
      subject: async () => ({}),
      summaryModel: async () => undefined,
      requestSummary: async () => {},
    }),
  )
  const service = workspaces(host)
  if (messagesEnabled) prepared.registry.install(messagesExtension(host))
  prepared.registry.install(workspaceExtension(host))
  prepared.registry.install(self(host))
  prepared.registry.install(subagents(host))
  prepared.registry.install(CodingTools)
  let writes = 0
  /** Requests a user's `ASK …` question started. */
  const asked: Parameters<FauxResponseFactory>[0][] = []
  prepared.registry.install(
    defineExtension({
      name: 'test-writing',
      tools: [
        defineTool({
          name: 'write_commit',
          description: 'Write and commit a change',
          parameters: obj({}),
          async execute(_args, api) {
            writes++
            const cwd = api.env!.cwd
            await writeFile(join(cwd, 'change.txt'), 'change')
            await git(cwd, 'add', '.')
            await git(cwd, 'commit', '-m', 'workspace change')
            return { output: [{ type: 'text', text: 'committed' }] }
          },
        }),
      ],
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (last.role === 'user' && text.startsWith('ASK ')) {
      asked.push(transcript)
      return fauxAssistantMessage('Nothing landed yet.')
    }
    if (last.role === 'user' && text.startsWith('CALL ')) {
      const { tool, args } = JSON.parse(text.slice(5))
      return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: 'toolUse' })
    }
    if (last.role === 'toolResult') return fauxAssistantMessage(text)
    return fauxAssistantMessage('finished')
  }
  prepared.faux!.setResponses([route])
  opened = await prepared.open()
  for (const open of openers) await open()
  started = true
  cleanup.push(async () => {
    for (const close of closers) await close()
    await opened.close()
  })
  const create = async () => {
    const result = await actions.create({}, { host } as ActionContext)
    await opened.harness.commit(
      (tx) => tx.appendEntry(result.id, { kind: 'test.submission', data: {} }),
      context,
    )
    return result.id
  }
  const call = async (id: ConversationId, tool: string, args: object = {}) => {
    const conversation = (await opened.harness.conversation(id, context))!
    await (
      await conversation.submit(
        { type: 'input', content: `CALL ${JSON.stringify({ tool, args })}` },
        context,
      )
    ).wait(context)
    await conversation.waitForIdle(context)
    const view = await conversation.context(context)
    return view.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)?.model?.[0]
  }
  return {
    ...paths,
    prepared,
    host,
    service,
    restart,
    notice,
    create,
    call,
    get opened() {
      return opened
    },
    get writes() {
      return writes
    },
    asked,
    reopen: async () => {
      for (const close of closers) await close()
      await opened.close()
      opened = await prepared.open()
      for (const open of openers) await open()
    },
  }
}
export async function commit(path: string, name = 'change.txt') {
  await writeFile(join(path, name), name)
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', name)
  return git(path, 'rev-parse', 'HEAD')
}
/**
 * Hold the first `git <command>` in the repository at `path` (and its worktrees) at its first ref update, with a
 * reference-transaction hook, until `release`; with `fail`, that update then fails, after the command changed the files.
 */
export async function holdGit(path: string, command: string, fail = false) {
  const started = join(path, `.git/${command}-started`)
  const gate = join(path, `.git/${command}-gate`)
  await writeFile(
    join(path, '.git/hooks/reference-transaction'),
    `#!/bin/sh
cat >/dev/null
[ "$1" = prepared ] && [ ! -f '${started}' ] || exit 0
case "$(ps -ww -p "$PPID" -o args=)" in "git ${command} "*) ;; *) exit 0 ;; esac
mkfifo '${gate}'
touch '${started}'
read release < '${gate}'
${fail ? 'exit 1' : ''}
`,
    { mode: 0o755 },
  )
  return {
    started: () =>
      until(() =>
        access(started).then(
          () => true,
          () => false,
        ),
      ),
    release: () => writeFile(gate, 'ready\n'),
  }
}
export async function submitted(f: Awaited<ReturnType<typeof fixture>>, id: ConversationId) {
  await until(async () => {
    const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    return !index.queue.length && !Object.keys(index.landers).length
  })
  const conversation = (await f.opened.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  const view = await conversation.context(context)
  const reports = view.entries.filter((entry) => entry.kind === 'workspaces.lander-report')
  for (const report of reports) {
    const { id: submission, outcome } = report.data as {
      id: string
      outcome: WorkspaceIndex['results'][string]
    }
    const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
    expect(outcome).toEqual(index.results[submission])
    expect(outcome.lander).toBeGreaterThan(0)
    expect(outcome.steps.length).toBeGreaterThan(0)
  }
  return reports.map((entry) => JSON.stringify(entry.model))
}
/** The lander conversation of the project source and its `ultimate.lander` log. */
export async function landerLog(f: Awaited<ReturnType<typeof fixture>>) {
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  const id = index.landerConversations[await realpath(f.projectRoot)] as ConversationId
  const conversation = (await f.opened.harness.conversation(id, context))!
  const view = await conversation.context(context)
  return {
    id,
    metadata: await f.opened.harness.snapshot(Metadata, id, context),
    cwd: (await conversation.agent(context)).cwd,
    kinds: view.entries.map((entry) => entry.kind),
    log: view.entries
      .filter((entry) => entry.kind === 'ultimate.lander')
      .map((entry) => entry.data as LanderEntry),
  }
}
export async function rootNotes(f: Awaited<ReturnType<typeof fixture>>) {
  const root = (await f.opened.harness.conversation(ROOT_CONVERSATION_ID, context))!
  const view = await root.context(context)
  return view.entries.filter((entry) => entry.kind === 'lineage.note')
}

export const messageLog = async (f: Awaited<ReturnType<typeof fixture>>) =>
  (await f.opened.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? []

export async function lander(
  settings: JsonObject,
  existing?: Awaited<ReturnType<typeof repository>>,
  messagesEnabled = false,
) {
  const f = await fixture([], existing, messagesEnabled)
  f.host.projectSettings = async () => ({ lander: settings })
  return f
}
