import { fauxServer, post, prepareFauxServer, sourceCopy, temp, until } from './helpers.ts'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension } from '@earendil-works/pi-durable'
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { TreesService } from '../extensions/conversations/api.ts'
import {
  generateSummary,
  Summaries,
  summaryBehavior,
  type SummaryHost,
  requestSummary,
  TitleChanged,
} from '../extensions/conversations/summary.ts'

export const luna = { provider: 'openai-codex', id: 'gpt-6-luna', thinking: 'medium' } as const
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
const sharedServers = new Map<string, Promise<Awaited<ReturnType<typeof fauxServer>>>>()
const baseConversations = new WeakMap<object, ReturnType<typeof defineExtension>>()
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})
// One read-only copy of the source for every server here, instead of a copy per launch.
let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp('ultimate-summary-source-'))
})
/** Waits for the test's gate, or gives up when the summary task is aborted, as when a failed test closes its server. */
export const held = (gate: Promise<void>, signal: AbortSignal) =>
  Promise.race([
    gate,
    new Promise<never>((_done, fail) =>
      signal.addEventListener('abort', () => fail(new Error('Closed')), { once: true }),
    ),
  ])
/**
 * A new conversation under test on a server shared by every launch with the same fixture flags. `own` boots a server
 * for this test alone: it reopens the server, or asserts on the whole server.
 */
export async function launch({
  subagents = false,
  initialIntent = false,
  root = false,
  branch = false,
  own = false,
} = {}) {
  const abstract = vi.fn<
    (
      tx: import('@earendil-works/pi-durable').Tx,
      id: number,
      data: { text: string; at: number },
    ) => Promise<void>
  >(async (tx, id, data) => {
    await tx.appendEntry(id as ConversationId, { kind: 'test.abstract', data })
  })
  const key = JSON.stringify([subagents, initialIntent, root, branch])
  let options!: { ultimateRoot: string; projectRoot: string; userHome: string; home: string }
  let server: Awaited<ReturnType<typeof fauxServer>>
  const boot = async () => {
    const home = await temp('ultimate-summary-')
    const projectRoot = join(home, 'project')
    await mkdir(join(projectRoot, '.ultimate/agents'), { recursive: true })
    // Only the extensions under test: each other one adds to every boot and reopen.
    const tested = ['conversations', ...(subagents ? ['subagents'] : [])]
    await writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      JSON.stringify({
        extensions: {
          disable: (await readdir(join(ultimateRoot, 'extensions'), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !tested.includes(entry.name))
            .map((entry) => entry.name),
        },
      }),
    )
    if (subagents)
      await writeFile(
        join(projectRoot, '.ultimate/agents/summary-child.md'),
        '---\nname: summary-child\ndescription: Summary test child\ntools: [summary_hold]\n---\nWait for release.\n',
      )
    options = { ultimateRoot, projectRoot, userHome: home, home: join(home, 'state') }
    return fauxServer(options)
  }
  if (own) server = await boot()
  else {
    if (!sharedServers.has(key)) sharedServers.set(key, boot())
    server = await sharedServers.get(key)!
  }
  if (!servers.includes(server)) servers.push(server)
  if (!baseConversations.has(server))
    baseConversations.set(server, server.host.registry.snapshot().extension('conversations')!)
  // A shared server may still finish an earlier test's summary; it must not call this test's mocks.
  await until(async () =>
    (await server.harness.inspect(context)).tasks.every(
      (task) => task.record.kind !== 'conversations.summary',
    ),
  )
  server.host.faux!.setResponses([])
  const { id: conversationId } = (await post(server, '/api/conversations', {})).data as {
    id: number
  }
  let conversation = (await server.harness.conversation(conversationId as ConversationId, context))!
  if (!initialIntent)
    await server.harness.commit(
      (tx) =>
        tx.appendEntry(conversation.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
        }),
      context,
    )
  const generated = vi.fn<typeof generateSummary>(async () => ({
    activity: 'Added concise summaries to the sidebar.',
    title: 'Improve the conversation sidebar',
    summary: 'Added concise summaries to the sidebar.',
    ...(branch ? { abstract: 'Ask: improve sidebar\nDiverged: none\nState: done' } : {}),
  }))
  const questionsRequested = vi.fn<() => Promise<void>>(async () => {})
  const install = (registry = server.host.registry, base = baseConversations.get(server)) => {
    vi.spyOn(server.host.modelRuntime, 'getAvailableSnapshot').mockImplementation(() => [
      server.host.faux!.getModel(),
      ...server.host.modelRuntime
        .getModels()
        .filter((model) => model.provider === 'openai-codex' && model.id === 'gpt-6-luna'),
    ])
    const existing = base ?? registry.snapshot().extension('conversations')!
    registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            userHome: server.host.userHome,
            projectSettings: async () => ({}),
            notice: () => {},
            modelRuntime: {
              getAvailableSnapshot: () =>
                server.host.modelRuntime
                  .getModels()
                  .filter(
                    (model) => model.provider === 'openai-codex' && model.id === 'gpt-6-luna',
                  ),
            },
            // Lineage stays off here; a rooted fixture stands in for it with every conversation its own root.
            want: ((api: { name: string }) =>
              api.name === 'questions'
                ? { request: questionsRequested }
                : api.name === 'conversations.trees' && (root || branch)
                  ? ({
                      rootOf: async (id: number) => (root ? id : undefined),
                      branchOf: async () =>
                        branch ? { root: 1, intent: 'Improve the sidebar' } : undefined,
                      abstract,
                    } satisfies TreesService)
                  : undefined) as NonNullable<SummaryHost['want']>,
          },
          generated,
        ),
      }),
    )
  }
  install()
  const read = () => server.harness.snapshot(Summaries, conversation.id, context)
  const exchange = async () => {
    const before = (await read())?.lastAnswer
    server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
    const submission = await conversation.submit(
      { type: 'input', content: 'Improve this conversation.' },
      context,
    )
    expect((await submission.wait(context)).status).toBe('done')
    await until(async () => (await read())?.lastAnswer !== before && !(await read())?.pending)
  }
  return {
    get server() {
      return server
    },
    /** The conversation under test, followed across a reopen. */
    get conversation() {
      return conversation
    },
    generated,
    questionsRequested,
    abstract,
    spawn: (answer: EntryId) =>
      server.harness.commit(
        (tx) =>
          requestSummary(
            tx,
            {
              harness: () => server.harness,
              metadata: Metadata,
              userHome: server.host.userHome,
              projectSettings: async () => ({}),
              notice: () => {},
              modelRuntime: server.host.modelRuntime,
            },
            conversation.id,
            { reason: 'spawn', answer, agent: 'scout', task: 'Continue the plan.' },
            luna,
          ),
        context,
      ),
    entries: async (id = conversation.id) =>
      (await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 200), context))
        .items,
    titleChanges: async (id = conversation.id) =>
      (
        await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 100), context)
      ).items.filter((entry) => TitleChanged.is(entry)),
    install,
    read,
    exchange,
    action: (name: string, title?: string) =>
      post(server, `/api/extensions/conversations/actions/${name}`, {
        args: { id: conversation.id, ...(title !== undefined && { title }) },
      }),
    reopen: async () => {
      await server.close()
      servers.splice(servers.indexOf(server), 1)
      const prepared = await prepareFauxServer(options)
      const base = prepared.host.registry.snapshot().extension('conversations')!
      install(prepared.host.registry, base)
      const reopened = { ...prepared, ...(await prepared.go()) }
      baseConversations.set(reopened, base)
      server = reopened
      conversation = (await server.harness.conversation(conversationId as ConversationId, context))!
      const close = server.close.bind(server)
      server.close = async () => {
        await server.vite.watcher.close()
        await close()
      }
      servers.push(server)
    },
  }
}
