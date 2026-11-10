// First: helpers mocks the faux provider's token pacing, which must apply before the server modules load.
import { post, until } from '../../../test/helpers.ts'
import { obj } from '@earendil-works/pi-schema'
import type { ConversationId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import { Summaries, SummaryDiscarded } from '../summary.ts'
import { held, launch } from './conversations-summary-fixture.ts'

it('summarizes every completed exchange, not tools, streams or idle time; persists across reopen', async () => {
  const fixture = await launch({ own: true })
  const { server } = fixture
  let generation = 0
  fixture.generated.mockImplementation(async () => ({
    activity: 'Added concise summaries to the sidebar.',
    title: 'Improve the conversation sidebar',
    summary: `Sidebar summary ${++generation}.`,
  }))
  server.host.registry.install(
    defineExtension({
      name: 'summary-tools',
      tools: [
        defineTool({
          name: 'summary_probe',
          description: 'Probe',
          parameters: obj({}),
          execute: async () => ({ output: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }] }),
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('summary_probe', {}), { type: 'thinking', thinking: 'SECRET_THINKING' }],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Final response.'),
  ])
  const submission = await fixture.conversation.submit(
    { type: 'input', content: 'Work on the sidebar.' },
    context,
  )
  expect((await submission.wait(context)).status).toBe('done')
  await until(() => fixture.generated.mock.calls.length === 1)
  await until(async () => (await fixture.read())?.status === 'ready')
  expect((await fixture.read())?.exchanges).toBe(1)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 1.')
  expect(fixture.generated.mock.calls[0][1]).not.toMatch(/SECRET_TOOL_OUTPUT|SECRET_THINKING/)
  for (let count = 2; count <= 4; count++) {
    await fixture.exchange()
    await until(async () => (await fixture.read())?.exchanges === count)
    await fixture.server.harness.waitForIdle(context)
    expect((await fixture.read())?.summary).toBe(`Sidebar summary ${count}.`)
  }
  expect((await server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title).toBe(
    'Improve the conversation sidebar',
  )
  const changes = await fixture.titleChanges()
  expect(changes).toHaveLength(1)
  expect(changes[0].data).toEqual({
    title: 'Improve the conversation sidebar',
    model: 'openai-codex/gpt-6-luna',
    at: expect.any(Number),
  })
  expect(changes[0].model).toBeUndefined()
  const view = await fixture.conversation.context(context)
  expect(view.contributions[view.entries.findIndex((entry) => entry.id === changes[0].id)]).toEqual(
    [],
  )
  expect(JSON.stringify(view.messages)).not.toContain('Improve the conversation sidebar')
  await fixture.reopen()
  expect(await fixture.titleChanges()).toEqual(changes)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 4.')
  expect((await fixture.read())?.exchanges).toBe(4)
  await fixture.exchange()
  await until(async () => (await fixture.read())?.exchanges === 5)
  await fixture.server.harness.waitForIdle(context)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 5.')
  await fixture.server.harness.waitForIdle(context)
  expect(await fixture.titleChanges()).toEqual(changes)
})

it('logs each accepted title change once, but not a manual rename to the generated title', async () => {
  const fixture = await launch({ own: true })
  const started = Date.now()
  await fixture.exchange()
  fixture.generated.mockResolvedValue({
    activity: 'Refined the sidebar.',
    title: 'Refine the sidebar',
    summary: 'Refined the sidebar.',
  })
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  const changes = await fixture.titleChanges()
  expect(changes.map((entry) => entry.data)).toEqual([
    { title: 'Refine the sidebar', model: 'openai-codex/gpt-6-luna', at: expect.any(Number) },
    {
      title: 'Improve the conversation sidebar',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  for (const entry of changes) {
    expect(entry.data.at).toBeGreaterThanOrEqual(started)
    expect(entry.data.at).toBeLessThanOrEqual(Date.now())
    expect(entry.model).toBeUndefined()
    expect(entry.byTaskId).toBeDefined()
  }
  await fixture.action('rename', 'Refine the sidebar')
  fixture.generated.mockResolvedValue({
    activity: 'Done.',
    title: 'Not accepted',
    summary: 'Done.',
  })
  for (let count = 5; count <= 7; count++) await fixture.exchange()
  expect(await fixture.titleChanges()).toEqual(changes)
  await fixture.reopen()
  expect(await fixture.titleChanges()).toEqual(changes)
})

it('keeps an explicit API title even when it equals the first input', async () => {
  const fixture = await launch({ own: true })
  const text = 'This preexisting title equals the prompt.'
  const created = await post(fixture.server, '/api/conversations', { title: text })
  expect(created.status).toBe(201)
  const id = created.data.id as ConversationId
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
  expect((await post(fixture.server, `/api/conversations/${id}/submit`, { text })).status).toBe(202)
  await until(
    async () => (await fixture.server.harness.snapshot(Summaries, id, context))?.status === 'ready',
  )
  expect(await fixture.server.harness.snapshot(Metadata, id, context)).toMatchObject({
    title: text,
  })
  await fixture.reopen()
  expect(await fixture.server.harness.snapshot(Metadata, id, context)).toMatchObject({
    title: text,
  })
  expect(await fixture.titleChanges(id)).toEqual([])
})

it('protects preexisting and in-flight manual titles, and blank rename restores automatic naming', async () => {
  const fixture = await launch()
  await fixture.server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, fixture.conversation.id)).title = 'Existing title'
  }, context)
  await fixture.exchange()
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title,
  ).toBe('Existing title')
  await fixture.action('rename', '')
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  for (let count = 2; count <= 3; count++) await fixture.exchange()
  const changes = await fixture.titleChanges()
  expect(changes).toHaveLength(1)
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return {
      activity: 'Implemented the requested sidebar changes.',
      title: 'An automatically updated title',
      summary: 'Updated summary.',
    }
  })
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Fourth answer.')])
  const fourth = await fixture.conversation.submit(
    { type: 'input', content: 'Fourth input' },
    context,
  )
  await fourth.wait(context)
  await until(async () => (await fixture.read())?.status === 'pending')
  // Background work does not keep the conversation busy or block its idle wait.
  await fixture.conversation.waitForIdle(context)
  await fixture.action('rename', 'My deliberate title')
  release()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title,
  ).toBe('My deliberate title')
  expect((await fixture.read())?.summary).toBe('Updated summary.')
  expect(await fixture.titleChanges()).toEqual(changes)
  await fixture.action('rename', '')
  await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
  expect(await fixture.titleChanges()).toHaveLength(2)
})

it('isolates provider errors', async () => {
  const fixture = await launch({ branch: true })
  fixture.generated.mockRejectedValueOnce(new Error('Provider offline'))
  fixture.generated.mockRejectedValueOnce(new Error('Provider offline'))
  await fixture.exchange()
  expect((await fixture.read())?.status).toBe('error')
  expect((await fixture.read())?.assessmentStatus).toBe('error')
  expect((await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))[0]?.data).toEqual({
    reason: 'error',
    cause: 'Provider offline',
    model: 'openai-codex/gpt-6-luna',
    at: expect.any(Number),
  })
  expect((await fixture.read())?.summary).toBeUndefined()
  expect(fixture.abstract).not.toHaveBeenCalled()
  expect(await fixture.titleChanges()).toEqual([])
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(fixture.generated).toHaveBeenCalledTimes(4)
})

it('assesses owned children without renaming them, summarizes ownerless forks, and does not backfill', async () => {
  const fixture = await launch()
  const root = fixture.conversation
  await fixture.server.harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Historical input', timestamp: 1 }],
      }),
    context,
  )
  expect(fixture.generated).not.toHaveBeenCalled()
  const anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'summary-anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: async (_task, runtime, caller) => {
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          caller,
        )
      },
    },
    abort: async (_task, runtime, caller) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller)
    },
  })
  const child = await fixture.server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: root.id,
      background: true,
    })
    const created = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    Object.assign(await tx.doc(Metadata, created.id), {
      title: 'Scout the task boundaries',
      label: 'scout',
    })
    return created
  }, context)
  const entry = await fixture.server.harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.assistant',
        model: [fauxAssistantMessage('Historical answer.')],
      }),
    context,
  )
  const fork = await root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  const inherited = await fixture.entries(fork.id)
  expect(inherited.some((item) => item.kind === 'pi.user')).toBe(true)
  expect(inherited.some((item) => item.kind === 'pi.assistant')).toBe(true)
  expect(inherited.every((item) => item.conversationId === root.id)).toBe(true)
  for (const id of [child.id, fork.id]) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Child answer.')])
    const conversation = (await fixture.server.harness.conversation(id, context))!
    expect(
      (
        await (
          await conversation.submit({ type: 'input', content: 'Child input' }, context)
        ).wait(context)
      ).status,
    ).toBe('done')
  }
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Summaries, child.id, context))?.assessmentStatus ===
      'ready',
  )
  expect((await fixture.server.harness.snapshot(Summaries, child.id, context))?.exchanges).toBe(1)
  expect(
    (await fixture.server.harness.snapshot(Summaries, child.id, context))?.summary,
  ).toBeUndefined()
  expect(await fixture.server.harness.snapshot(Metadata, child.id, context)).toMatchObject({
    title: 'Scout the task boundaries',
    label: 'scout',
  })
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Summaries, fork.id, context))?.assessmentStatus ===
      'ready',
  )
  expect((await fixture.server.harness.snapshot(Summaries, fork.id, context))?.exchanges).toBe(1)
  expect(fixture.generated).toHaveBeenCalledTimes(3)
  expect(await fixture.titleChanges(child.id)).toEqual([])
  expect(await fixture.titleChanges(fork.id)).toEqual([
    expect.objectContaining({
      data: expect.objectContaining({ title: 'Improve the conversation sidebar' }),
    }),
  ])
  await fixture.exchange()
  expect(fixture.generated).toHaveBeenCalledTimes(4)
  expect(fixture.generated.mock.calls.filter((call) => call[5] === 'intent')).toHaveLength(1)
})
