import { awaitWithContext } from '@earendil-works/chord/context'
import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Started } from '../extensions/messages/addresses.ts'
import { Automations } from '../extensions/automations/server.ts'
import { fauxServer, until } from './helpers.ts'
import { ultimateRoot, servers, fixture, entries } from './side-chat-fixture.ts'

describe('side chats', () => {
  it('owns branches and notify tasks in main and leaves one non-waking note for each', async () => {
    const f = await fixture()
    const side = await f.open()
    await f.call(side, 'branch', {
      prompt: 'bounded work',
      root: ROOT_CONVERSATION_ID,
      isolated: false,
    })
    await until(async () =>
      (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.some(
        (message) => message.text === 'bounded work',
      ),
    )
    const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
    const message = board.messages.find((sent) => sent.text === 'bounded work')!
    expect(message.from).toBe(f.main)
    expect(
      (await f.server.harness.snapshot(Started, message.to as ConversationId, context))!.by,
    ).toBe(f.main)
    await f.call(side, 'notify', { id: message.to, wake: false })
    await until(async () =>
      (await entries(f.server, f.main)).some(
        (entry) =>
          entry.kind === 'lineage.note' &&
          (entry.data as { source?: string })?.source === 'finished',
      ),
    )
    const tasks = await f.server.harness.commit(
      async (tx) =>
        (await tx.scanTasks({ conversationId: f.main, kind: 'lineage.notify' }, 100)).items,
      context,
    )
    expect(tasks).toHaveLength(1)
    const notes = (await entries(f.server, f.main))
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => JSON.stringify(entry.data))
    expect(notes.filter((text) => text.includes(`Side chat #${side} started branch`))).toHaveLength(
      1,
    )
    expect(
      notes.filter((text) => text.includes(`Side chat #${side} requested notification`)),
    ).toHaveLength(1)
  })

  it.each([false, true])(
    'recovers notify provenance exactly once after a crash (after note: %s)',
    async (afterNote) => {
      const f = await fixture()
      const side = await f.open()
      const target = await f.server.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        context,
      )
      const reached = Promise.withResolvers<void>()
      const forever = Promise.withResolvers<void>()
      const extension = f.server.host.registry.snapshot().extension('lineage')!
      f.server.host.registry.install(
        defineExtension({
          ...extension,
          tools: extension.tools!.map((tool) =>
            tool.name !== 'notify'
              ? tool
              : {
                  ...tool,
                  execute: (input, api, ctx) =>
                    tool
                      .execute(
                        input,
                        {
                          ...api,
                          commit: async (change, caller) => {
                            const result = await api.commit(change, caller)
                            if (!afterNote) {
                              reached.resolve()
                              await awaitWithContext(forever.promise, caller)
                            }
                            return result
                          },
                        },
                        ctx,
                      )
                      .then(async (result) => {
                        if (afterNote) {
                          reached.resolve()
                          await awaitWithContext(forever.promise, ctx)
                        }
                        return result
                      }),
                },
          ),
        }),
      )
      const pending = f
        .call(side, 'notify', { id: target.id, wake: false })
        .catch((error: unknown) => error)
      await reached.promise
      const provenance = async (server: typeof f.server) =>
        (await entries(server, f.main)).filter(
          (entry) =>
            entry.kind === 'lineage.note' &&
            JSON.stringify(entry.data).includes(`Side chat #${side} requested notification`),
        )
      expect(await provenance(f.server)).toHaveLength(afterNote ? 1 : 0)
      servers.splice(servers.indexOf(f.server), 1)
      await f.server.close()
      await pending
      const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
      servers.push(reopened)
      reopened.host.faux!.setResponses([fauxAssistantMessage('Recovered')])
      reopened.harness.resume()
      await (await reopened.harness.conversation(side, context))!.waitForIdle(context)
      expect(await provenance(reopened)).toHaveLength(1)
      const tasks = await reopened.harness.commit(
        async (tx) =>
          (await tx.scanTasks({ conversationId: f.main, kind: 'lineage.notify' }, 100)).items,
        context,
      )
      expect(tasks).toHaveLength(1)
    },
  )

  it('subscribes main by default and records the provenance without spawning a script', async () => {
    const f = await fixture()
    const side = await f.open()
    // Subscribe to an existing stopped record: no script or subprocess is needed to test ownership.
    await f.server.harness.commit(async (tx) => {
      const state = await tx.doc(Automations)
      state.next = 2
      state.automations.A1 = {
        id: 'A1',
        name: 'test',
        script: { ask: 'test', once: true, secrets: [], conversationId: f.main, state: 'stopped' },
        subscribers: [],
        runs: [],
        fires: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: false,
      }
    }, context)
    await f.call(side, 'automation', { action: 'subscribe', id: 'A1' })
    const automations = await f.server.harness.snapshot(Automations, context)
    expect(automations!.automations.A1.subscribers).toEqual([f.main])
    await f.call(side, 'automation', { action: 'create', name: 'Test', ask: 'test creation only' })
    // The dummy watcher only answers, so it now escalates rather than leaving a script stuck in writing.
    await until(
      async () =>
        (await f.server.harness.snapshot(Automations, context))!.automations.A2.script!.state ===
        'failed',
    )
    const created = (await f.server.harness.snapshot(Automations, context))!.automations.A2
    expect(created.subscribers).toEqual([f.main])
    expect(created.script!.error).toContain('The watcher stopped while the script was writing')
    expect(created.script!.pid).toBeUndefined()
    expect(
      (await entries(f.server, f.main)).filter(
        (entry) =>
          entry.kind === 'lineage.note' &&
          JSON.stringify(entry.data).includes(`Side chat #${side} created automation A2`),
      ),
    ).toHaveLength(1)
    expect(
      (await entries(f.server, f.main)).filter(
        (entry) =>
          entry.kind === 'lineage.note' &&
          JSON.stringify(entry.data).includes(`Side chat #${side} subscribed`),
      ),
    ).toHaveLength(1)
  })
})
