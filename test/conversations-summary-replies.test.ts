// First: helpers mocks the faux provider's token pacing, which must apply before the server modules load.
import { until } from './helpers.ts'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Subagents } from '../extensions/subagents/api.ts'
import { obj } from '@earendil-works/pi-schema'
import type { JsonObject } from '@earendil-works/pi-ai'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, LiveDoc } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import {
  setAutomaticSummaries,
  askSummaryModel,
  ReplySummarized,
  SummaryDiscarded,
} from '../extensions/conversations/summary.ts'
import { held, launch } from './conversations-summary-fixture.ts'

it('schedules no summary task for intent, reply or spawn once automatic summaries are off, while askSummaryModel still answers', async () => {
  const f = await launch({ initialIntent: true })
  await f.server.harness.commit(async (tx) => {
    Object.assign(await tx.doc(Metadata, f.conversation.id), { title: 'Side chat' })
    await setAutomaticSummaries(tx, f.conversation.id, false)
  }, context)
  f.server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
  const input = await f.conversation.submit({ type: 'input', content: 'Continue.' }, context)
  expect((await input.wait(context)).status).toBe('done')
  await f.spawn((await f.entries()).findLast((entry) => entry.kind === 'pi.assistant')!.id)
  const tasks = await f.server.harness.commit(
    (tx) => tx.scanTasks({ conversationId: f.conversation.id, kind: 'conversations.summary' }, 100),
    context,
  )
  expect(tasks.items).toEqual([])
  expect(await f.read()).toEqual({ exchanges: 0, revision: 0, automatic: false })
  expect(f.generated).not.toHaveBeenCalled()
  expect(await f.server.harness.snapshot(Metadata, f.conversation.id, context)).toMatchObject({
    title: 'Side chat',
  })
  // An explicit call is not a trigger: the flag leaves the summary model available.
  f.server.host.faux!.setResponses([fauxAssistantMessage('An explicit summary.')])
  const response = await askSummaryModel(
    f.server.host.modelRuntime,
    'Summarize.',
    'Some text.',
    AbortSignal.timeout(10_000),
    { model: { provider: 'faux', id: 'faux-1', thinking: 'off' } },
  )
  expect(response).toMatchObject({ text: 'An explicit summary.', stopReason: 'stop' })
  // Turned back on, the next exchange is summarized again.
  await f.server.harness.commit((tx) => setAutomaticSummaries(tx, f.conversation.id, true), context)
  await f.exchange()
  expect(f.generated).toHaveBeenCalledTimes(1)
  expect(await f.read()).not.toHaveProperty('automatic')
})

it.each(['agent', 'lander'])(
  'ends a summary admitted before the conversation became a standing %s without writing it',
  async (label) => {
    const f = await launch()
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    f.generated.mockImplementationOnce(async (_models, _input, signal) => {
      await held(gate, signal)
      return {
        activity: 'Implemented the sidebar.',
        title: 'A generated title',
        summary: 'A generated summary.',
        feature: 'Sidebar',
      }
    })
    f.server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
    const input = await f.conversation.submit({ type: 'input', content: 'Continue.' }, context)
    expect((await input.wait(context)).status).toBe('done')
    await until(async () => (await f.read())?.status === 'pending')
    await f.server.harness.commit(async (tx) => {
      Object.assign(await tx.doc(Metadata, f.conversation.id), { label, title: `@${label}` })
      await setAutomaticSummaries(tx, f.conversation.id, false)
    }, context)
    release()
    await until(
      async () => Object.values((await f.server.harness.inspect(context)).tasks).length === 0,
    )
    expect(f.generated).toHaveBeenCalledTimes(1)
    const state = await f.read()
    expect(state).not.toHaveProperty('pending')
    expect(state).not.toHaveProperty('status')
    expect(state).not.toHaveProperty('assessmentStatus')
    expect(state).not.toHaveProperty('summary')
    expect(state).not.toHaveProperty('feature')
    expect(state).not.toHaveProperty('activity')
    expect((await f.entries()).filter((entry) => ReplySummarized.is(entry))).toEqual([])
    expect(await f.titleChanges()).toEqual([])
    expect(await f.server.harness.snapshot(Metadata, f.conversation.id, context)).toMatchObject({
      title: `@${label}`,
    })
  },
)

it('does not request question extraction after an accepted reply summary', async () => {
  const f = await launch()
  f.generated.mockResolvedValue({ activity: 'Waiting for a decision.' })
  await f.exchange()
  expect((await f.read())?.activity).toBe('Waiting for a decision.')
  expect(f.questionsRequested).not.toHaveBeenCalled()
})

it('keeps an exchange current across a note: the held reply summary publishes, a spawn reads the input', async () => {
  const f = await launch()
  const gate = Promise.withResolvers<void>()
  f.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate.promise, signal)
    return { activity: 'Held reply.', title: 'Held title', summary: 'Held reply.' }
  })
  f.server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
  await (
    await f.conversation.submit({ type: 'input', content: 'Improve this conversation.' }, context)
  ).wait(context)
  await until(() => f.generated.mock.calls.length === 1)
  // A note is a user-role write, not an input: it neither starts an exchange nor makes the answer stale.
  await f.conversation.submit(
    {
      type: 'write',
      entry: {
        kind: 'lineage.note',
        model: [{ role: 'user', content: 'Later note', timestamp: Date.now() }],
      },
    },
    context,
  )
  gate.resolve()
  await until(async () => (await f.read())?.assessmentStatus === 'ready')
  expect((await f.read())?.summary).toBe('Held reply.')
  await f.spawn((await f.read())!.lastAnswer!)
  await until(() => f.generated.mock.calls.length === 2)
  expect(f.generated.mock.calls[1][1]).toContain('Improve this conversation.')
  expect(f.generated.mock.calls[1][1]).not.toContain('Later note')
})

it.each([false, true])(
  'refreshes during an actual subagent start, background=%s, while parent and child are busy',
  async (background) => {
    // It installs its own extensions and runs a child, neither of which a later test may inherit.
    const fixture = await launch({ subagents: true, own: true })
    const { server } = fixture
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const holding = new Set<number>()
    let replayed = false
    const interrupted = new Error('Replay after committed creation, before result receipt')
    server.host.registry.install(
      defineExtension({
        name: 'spawn-replay',
        wraps: [
          {
            tool: 'subagent',
            wrap: (tool: ToolRegistration): ToolRegistration => ({
              ...tool,
              execute: async (args, api, toolContext) => {
                try {
                  return await tool.execute(
                    args,
                    {
                      ...api,
                      details: async (value, caller) => {
                        if (!replayed) {
                          replayed = true
                          throw interrupted
                        }
                        return api.details(value, caller)
                      },
                    },
                    toolContext,
                  )
                } catch (error) {
                  if (error !== interrupted) throw error
                  return tool.execute(args, api, toolContext)
                }
              },
            }),
          },
        ],
      }),
    )
    server.host.registry.install(
      defineExtension({
        name: 'summary-hold',
        tools: [
          defineTool({
            name: 'summary_hold',
            description: 'Hold work until released',
            parameters: obj({}),
            execute: async (_args, api, toolContext) => {
              holding.add(api.conversationId)
              await awaitWithContext(gate, toolContext)
              return { output: [{ type: 'text', text: 'Released' }] }
            },
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          { type: 'text', text: 'Plan: delegate the sidebar implementation, then verify it.' },
          fauxToolCall('subagent', {
            action: 'start',
            agent: 'summary-child',
            task: 'Implement the sidebar plan.',
            background,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxToolCall('summary_hold', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('summary_hold', {})], { stopReason: 'toolUse' }),
    ])
    const submission = await fixture.conversation.submit(
      { type: 'input', content: 'Plan and implement the sidebar.' },
      context,
    )
    try {
      await until(async () => (await fixture.read())?.status === 'ready')
      const agents = Object.values(
        (await server.harness.snapshot(Subagents, fixture.conversation.id, context))!.agents,
      )
      expect(agents).toHaveLength(1)
      expect(replayed).toBe(true)
      const child = agents[0].conversationId
      await until(() => holding.has(child))
      expect((await server.harness.snapshot(LiveDoc, child, context))?.run).toBeDefined()
      expect(
        (await server.harness.snapshot(LiveDoc, fixture.conversation.id, context))?.run,
      ).toBeDefined()
      expect((await submission.status(context)).status).toBe('placed')
      expect((await fixture.read())?.exchanges).toBe(0)
      expect((await fixture.read())?.activity).toBeUndefined()
      expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
      expect(
        (await server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title,
      ).toBe('Improve the conversation sidebar')
      expect(fixture.generated).toHaveBeenCalledTimes(1)
      expect(fixture.generated.mock.calls[0][1]).toContain(
        'Plan: delegate the sidebar implementation',
      )
      expect(fixture.generated.mock.calls[0][1]).toContain('Implement the sidebar plan.')
      expect(fixture.generated.mock.calls[0][5]).toBe('spawn')
    } finally {
      server.host.faux!.appendResponses(
        Array.from({ length: 6 }, () => fauxAssistantMessage('Completed delegated work.')),
      )
      release()
    }
    await submission.wait(context)
    await server.harness.waitForIdle(context)
    await until(
      async () => ((await fixture.read())?.exchanges ?? 0) >= 1 && !(await fixture.read())?.pending,
    )
    expect(fixture.generated.mock.calls.filter((call) => call[5] === 'spawn')).toHaveLength(1)
    expect(fixture.generated.mock.calls.some((call) => call[5] === 'reply' && call[3])).toBe(true)
    const child = Object.values(
      (await server.harness.snapshot(Subagents, fixture.conversation.id, context))!.agents,
    )[0].conversationId
    const actions: JsonObject[] = [
      { action: 'start', agent: 'missing-agent', task: 'Must fail' },
      { action: 'message', id: child, text: 'Follow up', background: true },
      { action: 'wait', id: child },
    ]
    for (const args of actions) {
      server.host.faux!.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', args)], { stopReason: 'toolUse' }),
        ...Array.from({ length: 6 }, () => fauxAssistantMessage('Final reply.')),
      ])
      await (
        await fixture.conversation.submit(
          { type: 'input', content: 'Exercise a non-spawn action' },
          context,
        )
      ).wait(context)
      await server.harness.waitForIdle(context)
      await until(async () =>
        Object.values((await server.harness.inspect(context)).tasks).every(
          (task) => task.record.kind !== 'conversations.summary',
        ),
      )
      expect(fixture.generated.mock.calls.filter((call) => call[5] === 'spawn')).toHaveLength(1)
    }
  },
)

it.each(['rename', 'newer'] as const)('protects a held spawn result after %s', async (change) => {
  const fixture = await launch()
  await fixture.exchange()
  const answer = (await fixture.read())!.lastAnswer!
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return {
      activity: 'Must not publish',
      title: 'Old spawn title',
      summary: 'Old spawn summary',
    }
  })
  await fixture.spawn(answer)
  await until(() => fixture.generated.mock.calls.length === 2)
  try {
    if (change === 'rename') await fixture.action('rename', 'Manual title')
    else await fixture.exchange()
  } finally {
    release()
  }
  await until(
    async () => Object.values((await fixture.server.harness.inspect(context)).tasks).length === 0,
  )
  await until(async () => !(await fixture.read())?.pending)
  const state = await fixture.read()
  const title = (await fixture.server.harness.snapshot(Metadata, fixture.conversation.id, context))
    ?.title
  expect(state?.activity).not.toBe('Must not publish')
  expect(title).toBe(change === 'rename' ? 'Manual title' : 'Improve the conversation sidebar')
  expect(state?.summary).toBe(
    {
      rename: 'Old spawn summary',
      newer: 'Added concise summaries to the sidebar.',
    }[change],
  )
  expect(state?.exchanges).toBe({ rename: 1, newer: 2 }[change])
})

it('settles a held spawn superseded by the next exchange, which publishes its own summary', async () => {
  const fixture = await launch()
  await fixture.exchange()
  const before = (await fixture.read())!
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return { activity: 'Old spawn', title: 'Old spawn', summary: 'Old spawn' }
  })
  await fixture.spawn(before.lastAnswer!)
  await until(() => fixture.generated.mock.calls.length === 2)
  expect((await fixture.read())?.status).toBe('pending')
  fixture.generated.mockResolvedValueOnce({
    activity: 'Refined the sidebar.',
    title: 'Refine the sidebar',
    summary: 'Refined the sidebar.',
  })
  try {
    await fixture.exchange()
    const state = await fixture.read()
    expect(state?.pending).toBeUndefined()
    expect(state?.assessmentStatus).toBe('ready')
    expect(state?.exchanges).toBe(2)
    expect(state?.summary).toBe('Refined the sidebar.')
    expect(fixture.generated.mock.calls.at(-1)![3]).toBe(true)
    expect(state?.status).toBe('ready')
  } finally {
    release()
  }
  await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
  expect((await fixture.read())?.status).toBe('ready')
  const discarded = (await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))
  expect(discarded.map((entry) => entry.data)).toEqual([
    {
      reason: 'stale',
      cause: 'superseded',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  const spawnTask = await fixture.server.harness.getTask(discarded[0].byTaskId!, context)
  expect(spawnTask?.kind).toBe('conversations.summary')
  expect(spawnTask?.input).toMatchObject({ spawn: { answer: before.lastAnswer } })
  expect((await fixture.read())?.summary).toBe('Refined the sidebar.')
})
