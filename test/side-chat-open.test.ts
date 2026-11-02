import { describe, expect, it } from 'vitest'
import {
  AgentDoc,
  defineExtension,
  hook,
  ROOT_CONVERSATION_ID,
  ToolTask,
} from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { branchOf, rootOf } from '../extensions/lineage/server.ts'
import { Branch } from '../extensions/lineage/api.ts'
import { Index, Side } from '../extensions/side-chat/server.ts'
import { until } from './helpers.ts'
import { fixture, entries } from './side-chat-fixture.ts'

describe('side chats', () => {
  it('forks the last completed run while main is busy, preserves the entire prompt including codemode and all tools, and stays outside lineage', async () => {
    const f = await fixture()
    const mainBefore = f.requests.at(-1)!
    const finished = (await entries(f.server, f.main)).at(-1)!.id
    let entered = false
    const messages = f.server.host.registry.snapshot().extension('messages')!
    f.server.host.registry.install(
      defineExtension({
        ...messages,
        hooks: [
          ...(messages.hooks ?? []),
          hook(ToolTask, {
            beforeTool: async (call) => {
              if (call.name === 'message') {
                entered = true
                await f.hold.promise
              }
              return undefined
            },
          }),
        ],
      }),
    )
    const running = await (await f.server.harness.conversation(f.main, context))!.submit(
      {
        type: 'input',
        content: `CALL ${JSON.stringify({ name: 'message', args: { to: 'user', text: 'holding main' } })}`,
      },
      context,
    )
    await until(() => entered)
    const unfinished = (await entries(f.server, f.main)).at(-1)!
    expect(unfinished.kind).toBe('pi.assistant')
    expect(unfinished.model?.[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'toolCall', name: 'message' })]),
    )
    const side = await f.open()
    const doc = await f.server.harness.snapshot(Side, side, context)
    expect(doc).toEqual({ of: f.main, at: finished, effects: false })
    const fork = (await f.server.harness.conversation(side, context))!
    const sideEntries = await entries(f.server, side)
    expect(sideEntries.some((entry) => entry.id === unfinished.id)).toBe(false)
    const own = sideEntries.filter((entry) => entry.conversationId === side)
    const reminder = own.findIndex(
      (entry) =>
        entry.kind === 'conversations.identity' &&
        JSON.stringify(entry.model).includes(`You are in a side chat (#${side})`),
    )
    expect(reminder).toBeGreaterThanOrEqual(0)
    // The reminder is read before the user's first words.
    expect(own.findIndex((entry) => entry.kind === 'pi.user')).toBeGreaterThan(reminder)
    expect(f.requests.at(-1)!.system).toBe(mainBefore.system)
    expect(mainBefore.system).toContain('codemode')
    expect(await f.server.harness.snapshot(AgentDoc, side, context)).toEqual(
      await f.server.harness.snapshot(AgentDoc, f.main, context),
    )
    expect((await fork.agent(context)).tools.map((tool) => tool.name)).toEqual(
      (await (await f.server.harness.conversation(f.main, context))!.agent(context)).tools.map(
        (tool) => tool.name,
      ),
    )
    expect((await f.server.harness.snapshot(AgentDoc, side, context))!.tools).toContain('compact')
    const host = { harness: () => f.server.harness }
    expect(await branchOf(host, side, context)).toBeUndefined()
    expect(await rootOf(host, side, context)).toBeUndefined()
    expect((await f.server.harness.snapshot(Branch, side, context))?.branch).toBeUndefined()
    await until(
      () =>
        f.server.api.conversations().find((conversation) => conversation.id === side)?.label ===
        'side-chat',
    )
    const listed = f.server.api.conversations().find((conversation) => conversation.id === side)!
    expect(listed.label).toBe('side-chat')
    expect(listed.branchOf).toEqual({ conversationId: f.main, at: finished })
    const index = await f.server.harness.snapshot(Index, f.main, context)
    expect(index!.sides).toEqual([{ id: side, at: finished, openedAt: expect.any(Number) }])
    expect((await f.action('open', { text: 'nested' }, side)).data.error).toMatch(
      /cannot open another/,
    )
    expect((await f.action('open', { text: 'wrong' }, ROOT_CONVERSATION_ID)).data.error).toMatch(
      /Only @ultimate/,
    )
    const second = await f.open('ANOTHER')
    expect(second).not.toBe(side)
    f.hold.resolve()
    await running.wait(context)
  })

  it('a side chat gets no automatic summary, and only the user opens one', async () => {
    const f = await fixture()
    const side = await f.open()
    await f.ask(side, 'A question answered in the side chat.')
    const tasks = await f.server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: side, kind: 'conversations.summary' }, 100),
      context,
    )
    expect(tasks.items).toEqual([])
    // No intent or reply summary entry: only the hidden identity reminders are the conversations extension's.
    expect(
      (await entries(f.server, side)).filter(
        (entry) =>
          entry.conversationId === side &&
          entry.kind.startsWith('conversations.') &&
          entry.kind !== 'conversations.identity',
      ),
    ).toEqual([])
    expect(
      f.server.api.conversations().find((conversation) => conversation.id === side),
    ).toMatchObject({ title: 'Side chat' })
    // Only the user opens side chats: an agent's call is refused.
    await f.call(f.main, 'codemode', {
      code: "return await ultimate.action('side-chat', 'open', {text: 'agent must not open'})",
    })
    expect(JSON.stringify(await entries(f.server, f.main))).toContain(
      'side-chat/open is a user-only action',
    )
    expect((await f.server.harness.snapshot(Index, f.main, context))?.sides).toHaveLength(1)
  })

  it('includes terminal tool results and ignores completed generations inside an unfinished run', async () => {
    const f = await fixture()
    await f.call(f.main, 'message', { to: 'user', text: 'finished tool-terminated turn' })
    const closing = (await entries(f.server, f.main)).at(-1)!
    expect(closing.model?.[0].role).toBe('toolResult')
    const first = await f.open()
    expect((await f.server.harness.snapshot(Side, first, context))!.at).toBe(closing.id)
    f.gate.afterTool = true
    const running = f.call(f.main, 'note', { to: ROOT_CONVERSATION_ID, text: 'still working' })
    await until(() => f.gate.entered)
    // This tool round's generation is completed, but no input submission is answered yet.
    const side = await f.open()
    expect((await f.server.harness.snapshot(Side, side, context))!.at).toBe(closing.id)
    f.hold.resolve()
    await running
  })
})
