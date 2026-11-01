// First: helpers mocks the faux provider's token pacing, which must apply before the server modules load.
import { post, until } from './helpers.ts'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import {
  exchangeMessages,
  generateSummary,
  summaryInput,
  summaryBehavior,
  IntentSummarized,
  ReplySummarized,
  SummaryDiscarded,
} from '../extensions/conversations/summary.ts'
import { luna, held, launch } from './conversations-summary-fixture.ts'

const userMessage = (content: string) => ({ role: 'user' as const, content, timestamp: 1 })

it('leaves a Play note out of what names and summarizes a conversation', () => {
  const user = userMessage
  const entries = [
    { kind: 'pi.user', model: [user('phases demo')] },
    { kind: 'pause.note', model: [user('Paused for 1m; the run continued after Play.')] },
  ] as unknown as Parameters<typeof exchangeMessages>[0]['entries']
  const contributions = entries.map((entry) => entry.model ?? [])
  const input = summaryInput(exchangeMessages({ entries, contributions }))
  expect(input).toContain('user: phases demo')
  expect(input).not.toContain('Paused for')
})

it('includes the previous feature next to the previous summary in model input', () => {
  expect(summaryInput([], 'Previous work.', 'Bash rendering')).toContain(
    'Previous summary: Previous work.\n\nPrevious feature: Bash rendering',
  )
  expect(summaryInput([])).not.toContain('Previous feature:')
})

it('keeps the start and end of a long reply and marks what it left out', () => {
  const report = `Verdict: NEEDS CHANGES\n${'finding '.repeat(500)}\nResidual risks: none.`
  const input = summaryInput([
    { role: 'assistant', content: [{ type: 'text', text: report }] } as never,
  ])
  expect(input).toContain('assistant: Verdict: NEEDS CHANGES')
  expect(input).toContain(`[… ${report.length - 2400} characters omitted for length …]`)
  expect(input.endsWith('Residual risks: none.')).toBe(true)
})

it('asks a root for the feature its whole tree builds', async () => {
  const branch = await launch()
  await branch.exchange()
  expect(branch.generated.mock.calls.at(-1)![6]).toBeFalsy()
  const root = await launch({ root: true })
  await root.exchange()
  expect(root.generated.mock.calls.at(-1)![6]).toBe(true)
})

it('stores and exposes a feature and keeps it when omitted', async () => {
  const fixture = await launch()
  fixture.generated.mockResolvedValueOnce({
    activity: 'Added labels.',
    title: 'Feature labels',
    summary: 'Added labels.',
    feature: 'Conversation sidebar',
  })
  await fixture.exchange()
  expect((await fixture.read())?.feature).toBe('Conversation sidebar')
  const row = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.conversation.id]
  await until(async () => (await row())?.feature === 'Conversation sidebar')
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  expect(fixture.generated.mock.calls.at(-1)![1]).toContain(
    'Previous feature: Conversation sidebar',
  )
  expect((await fixture.read())?.feature).toBe('Conversation sidebar')
  expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
})

it('validates reply-only JSON and rejects a malformed activity', async () => {
  let output: unknown = {
    activity: 'Asked the coordinator to choose a deployment target.',
  }
  const stream = vi.fn<Models['streamSimple']>(() => {
    const events = new AssistantMessageEventStream()
    const answer = fauxAssistantMessage(JSON.stringify(output))
    events.push({ type: 'done', reason: 'stop', message: answer })
    events.end()
    return events
  })
  const getModel = vi.fn<(provider: string, id: string) => { provider: string; id: string }>(
    () => ({ provider: 'openai-codex', id: 'gpt-6-luna' }),
  )
  const models = {
    getModel,
    streamSimple: stream,
  } as unknown as Models
  expect(
    await generateSummary(models, 'Untrusted reply text', new AbortController().signal, false, {
      model: luna,
    }),
  ).toEqual(output)
  expect(getModel).toHaveBeenCalledWith('openai-codex', 'gpt-6-luna')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('"feature"')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('"abstract"')
  output = { activity: 'Done.', abstract: `  ${'x'.repeat(1300)}  ` }
  const abstractResult = await generateSummary(
    models,
    'Reply',
    new AbortController().signal,
    false,
    { model: luna },
    'reply',
    false,
    true,
  )
  expect(abstractResult.abstract).toBe('x'.repeat(1200))
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('"abstract"')
  expect(stream.mock.calls.at(-1)![2]?.maxTokens).toBe(2048)
  output = { activity: 'Done.' }
  await expect(
    generateSummary(
      models,
      'Reply',
      new AbortController().signal,
      false,
      { model: luna },
      'reply',
      false,
      true,
    ),
  ).rejects.toThrow('Invalid abstract response')
  output = {
    activity: 'Done.',
    title: 'Title',
    summary: 'Summary',
    feature: 'Bash rendering',
  }
  expect(
    await generateSummary(models, 'Reply', new AbortController().signal, true, { model: luna }),
  ).toEqual(output)
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Also include "feature"')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Keep the previous feature exactly')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('name the whole')
  await generateSummary(
    models,
    'Reply',
    new AbortController().signal,
    true,
    { model: luna },
    'reply',
    true,
  )
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('name the whole, not the part')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('product feature or area')
  output = { title: 'Delegate the sidebar', summary: 'Planning has moved to implementation.' }
  expect(
    await generateSummary(
      models,
      'Delegation',
      new AbortController().signal,
      true,
      { model: luna },
      'spawn',
    ),
  ).toEqual({
    ...(output as object),
    activity: '',
  })
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('work now starting')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Also include "feature"')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('Describe the latest final reply')
  await generateSummary(
    models,
    'Initial input',
    new AbortController().signal,
    true,
    { model: luna },
    'intent',
  )
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('initial intent')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('Also include "feature"')
  for (const malformed of [{}, { activity: null }, { activity: ['Done.'] }, null]) {
    output = malformed
    await expect(
      generateSummary(models, 'Reply', new AbortController().signal, false, { model: luna }),
    ).rejects.toThrow('Invalid reply summary response')
  }
})

it('publishes initial intent while the main model request is blocked, once across retries and reopen', async () => {
  const fixture = await launch({ initialIntent: true, own: true })
  const { server } = fixture
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  server.host.registry.install(
    defineExtension({
      ...server.host.registry.snapshot().extension('conversations')!,
      tools: [
        defineTool({
          name: 'intent_probe',
          description: 'Probe another model round',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'Continue' }] }),
        }),
      ],
      hooks: [
        ...server.host.registry.snapshot().extension('conversations')!.hooks!,
        hook(GenerationTask, {
          beforeRequest: async (_request, _api, caller) => {
            await awaitWithContext(gate, caller)
            return undefined
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('intent_probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Final answer.'),
  ])
  const submission = await fixture.conversation.submit(
    { type: 'input', content: 'Build a sidebar.' },
    context,
  )
  const intents = () =>
    fixture.server.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: fixture.conversation.id }, 100)).items.filter(
          (entry) => IntentSummarized.is(entry),
        ),
      context,
    )
  try {
    await until(async () => (await intents()).length === 1)
    expect((await submission.status(context)).status).toBe('placed')
    expect((await fixture.read())?.exchanges).toBe(0)
    expect((await fixture.read())?.activity).toBeUndefined()
    expect(fixture.generated.mock.calls.map((call) => call[5])).toEqual(['intent'])
    expect(fixture.generated.mock.calls[0][1]).toContain('Build a sidebar.')
    const entries = await intents()
    expect(entries[0].data).toEqual({
      summary: 'Added concise summaries to the sidebar.',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    })
    expect(entries[0].model).toBeUndefined()
    const view = await fixture.conversation.context(context)
    expect(JSON.stringify(view.messages)).not.toContain('Added concise summaries')
    expect(
      view.contributions[view.entries.findIndex((entry) => entry.id === entries[0].id)],
    ).toEqual([])
  } finally {
    release()
  }
  await submission.wait(context)
  await until(
    async () => (await fixture.read())?.exchanges === 1 && !(await fixture.read())?.pending,
  )
  const entries = await intents()
  await fixture.exchange()
  expect(await intents()).toEqual(entries)
  await fixture.reopen()
  expect(await intents()).toEqual(entries)
})

it.each(['newer', 'spawn'] as const)('rejects a held initial intent after %s', async (change) => {
  const fixture = await launch({ initialIntent: true })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return { activity: '', title: 'Stale intent', summary: 'Stale intent' }
  })
  // Hold the main request too, so the intent starts before any reply can supersede it.
  let resume!: () => void
  const main = new Promise<void>((done) => {
    resume = done
  })
  fixture.server.host.registry.install(
    defineExtension({
      ...fixture.server.host.registry.snapshot().extension('conversations')!,
      hooks: [
        ...fixture.server.host.registry.snapshot().extension('conversations')!.hooks!,
        hook(GenerationTask, {
          beforeRequest: async (_request, _api, caller) => {
            await awaitWithContext(main, caller)
            return undefined
          },
        }),
      ],
    }),
  )
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Final reply.')])
  await fixture.conversation.submit({ type: 'input', content: 'Initial goal' }, context)
  await until(() => fixture.generated.mock.calls.length === 1)
  try {
    if (change === 'newer')
      await fixture.conversation.submit({ type: 'input', content: 'Changed goal' }, context)
    else if (change === 'spawn') {
      const entries = await fixture.conversation.context(context)
      await fixture.spawn(entries.entries.find((entry) => entry.kind === 'pi.user')!.id)
    }
    release()
    await until(
      async () =>
        Object.values((await fixture.server.harness.inspect(context)).tasks).filter(
          (task) => task.record.kind === 'conversations.summary',
        ).length === 0,
    )
    const entries = await fixture.server.harness.commit(
      (tx) => tx.scanEntries({ conversationId: fixture.conversation.id }, 100),
      context,
    )
    expect(entries.items.filter((entry) => IntentSummarized.is(entry))).toEqual([])
    expect((await fixture.read())?.summary).not.toBe('Stale intent')
  } finally {
    release()
    resume()
    fixture.server.host.faux!.appendResponses([
      fauxAssistantMessage('Final reply.'),
      fauxAssistantMessage('Final reply.'),
    ])
    // The server is shared: the next test must not inherit this conversation's run.
    await fixture.conversation.waitForIdle(context)
  }
})

it('keeps an exchange answered across a mid-run compaction and reopen; only a reset ends it', async () => {
  const fixture = await launch({ own: true })
  const { server } = fixture
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let holding = false
  server.host.registry.install(
    defineExtension({
      name: 'compaction-hold',
      tools: [
        defineTool({
          name: 'compaction_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            holding = true
            await awaitWithContext(gate, toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('compaction_hold', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Final answer after compaction.'),
  ])
  const submission = await fixture.conversation.submit(
    { type: 'input', content: 'ORIGINAL_REQUEST: rename the sidebar.' },
    context,
  )
  await until(() => holding)
  // Compaction cuts past the user input while the run continues.
  await server.harness.commit(async (tx) => {
    const call = (await tx.scanEntries({ conversationId: fixture.conversation.id }, 10)).items.find(
      (entry) => entry.kind === 'pi.assistant',
    )!
    await tx.appendEntry(fixture.conversation.id, {
      kind: 'pi.compaction',
      head: call.id,
      data: { reason: 'manual' },
      model: [{ role: 'user', content: '<summary>\nCompacted.\n</summary>', timestamp: 2 }],
    })
  }, context)
  release()
  expect((await submission.wait(context)).status).toBe('done')
  await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  expect(fixture.generated.mock.calls.at(-1)![1]).toMatch(
    /^Original request \(untrusted source text\):\nuser: ORIGINAL_REQUEST: rename the sidebar\./,
  )
  expect(
    (await fixture.conversation.context(context)).messages.some((message) =>
      JSON.stringify(message).includes('ORIGINAL_REQUEST'),
    ),
  ).toBe(false)
  const row = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.conversation.id]
  await until(async () => (await row())?.runState === 'answered')
  expect(await row()).toMatchObject({
    activity: 'Added concise summaries to the sidebar.',
    assessmentStatus: 'ready',
  })
  await fixture.reopen()
  await until(async () => (await row())?.runState === 'answered')
  expect(await row()).toMatchObject({
    activity: 'Added concise summaries to the sidebar.',
    assessmentStatus: 'ready',
  })
  // A raw reset, like a tool handoff, ends the exchange even without a summary revision bump.
  await fixture.conversation.reset(undefined, context)
  await until(async () => (await row())?.runState === 'idle')
  expect((await row())?.inputId).toBeUndefined()
  expect((await row())?.answerId).toBeUndefined()
})

it('derives the same overview rows live and from a fresh open, with no summary model available', async () => {
  const fixture = await launch({ own: true })
  const install = () => {
    const registry = fixture.server.host.registry
    registry.install(
      defineExtension({
        ...registry.snapshot().extension('conversations')!,
        ...summaryBehavior(
          {
            harness: () => fixture.server.harness,
            metadata: Metadata,
            userHome: fixture.server.host.userHome,
            projectSettings: async () => ({}),
            notice: () => {},
            modelRuntime: { getAvailableSnapshot: () => [] },
          },
          fixture.generated,
        ),
      }),
    )
  }
  install()
  let release!: () => void
  fixture.server.host.registry.install(
    defineExtension({
      name: 'overview-hold',
      tools: [
        defineTool({
          name: 'overview_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            await awaitWithContext(new Promise<void>((done) => (release = done)), toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  const failure = fauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: 'invalid_request_error: deterministic fixture failure',
  })
  const hold = fauxAssistantMessage([fauxToolCall('overview_hold', {})], { stopReason: 'toolUse' })
  const create = async () => {
    const created = await post(fixture.server, '/api/conversations', {})
    const id = created.data.id as ConversationId
    return (await fixture.server.harness.conversation(id, context))!
  }
  const live = (id: ConversationId) =>
    fixture.server.harness.snapshot(LiveDoc, id, context).then((state) => state?.run)
  const submit = async (
    conversation: Awaited<ReturnType<typeof create>>,
    responses: ReturnType<typeof fauxAssistantMessage>[],
    during?: () => Promise<void>,
  ) => {
    fixture.server.host.faux!.setResponses(responses)
    const submission = await conversation.submit({ type: 'input', content: 'Work' }, context)
    if (during) {
      await until(async () => (await live(conversation.id)) !== undefined)
      await until(async () => (await fixture.server.harness.inspect(context)).tasks.length > 1)
      await during()
      release()
    }
    await submission.wait(context)
    await fixture.server.harness.waitForIdle(context)
  }
  const answered = await create()
  await submit(answered, [fauxAssistantMessage('Answered.')])
  const reset = await create()
  await submit(reset, [fauxAssistantMessage('Answered before reset.')])
  await reset.reset(undefined, context)
  const failed = await create()
  await submit(failed, [failure])
  const queued = await create()
  // The follow-up waits in the inbox; the failed run leaves it there.
  await submit(queued, [hold, failure], async () => {
    await queued.submit({ type: 'input', content: 'Later' }, context)
  })
  const compacted = await create()
  await submit(compacted, [hold, fauxAssistantMessage('Answered after compaction.')], () =>
    fixture.server.harness.commit(async (tx) => {
      const call = (await tx.scanEntries({ conversationId: compacted.id }, 10)).items.find(
        (entry) => entry.kind === 'pi.assistant',
      )!
      await tx.appendEntry(compacted.id, {
        kind: 'pi.compaction',
        head: call.id,
        data: { reason: 'manual' },
        model: [{ role: 'user', content: '<summary>\nCompacted.\n</summary>', timestamp: 2 }],
      })
    }, context),
  )
  const expected = {
    [answered.id]: 'answered',
    [reset.id]: 'idle',
    [failed.id]: 'error',
    [queued.id]: 'queued',
    [compacted.id]: 'answered',
  }
  const rows = async () => {
    const all = (await fixture.server.harness.snapshot(Overview, ROOT_CONVERSATION_ID, context))
      ?.conversations
    return Object.fromEntries(Object.keys(expected).map((id) => [id, all?.[id]]))
  }
  await until(async () =>
    Object.entries(await rows()).every(([id, row]) => row?.runState === expected[Number(id)]),
  )
  const built = await rows()
  expect(built[answered.id]).toEqual({
    runState: 'answered',
    inputId: expect.any(Number),
    answerId: expect.any(Number),
  })
  expect(built[reset.id]).toEqual({ runState: 'idle' })
  expect(built[failed.id]).toEqual({ runState: 'error', inputId: expect.any(Number) })
  expect(fixture.generated).not.toHaveBeenCalled()
  // The index is a projection: discard it, and a fresh open rebuilds it from the records alone.
  await fixture.server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations = {}
  }, context)
  await fixture.reopen()
  install()
  await until(async () => Object.values(await rows()).every((row) => row !== undefined))
  expect(await rows()).toEqual(built)
})

it('records an accepted reply summary as an entry traced to its summary and generation tasks', async () => {
  const fixture = await launch()
  await fixture.exchange()
  const state = (await fixture.read())!
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
        ?.conversations[fixture.conversation.id]?.runState === 'answered',
  )
  const row = (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))!
    .conversations[fixture.conversation.id]
  const entries = (await fixture.entries()).filter((entry) => ReplySummarized.is(entry))
  expect(entries.map((entry) => entry.data)).toEqual([
    {
      inputId: row.inputId,
      answerId: state.lastAnswer,
      activity: 'Added concise summaries to the sidebar.',
      model: 'openai-codex/gpt-6-luna',
      at: expect.any(Number),
    },
  ])
  expect(entries[0].model).toBeUndefined()
  const task = await fixture.server.harness.getTask(entries[0].byTaskId!, context)
  expect(task?.kind).toBe('conversations.summary')
  const generation = (task!.input as { generation: TaskId }).generation
  const run = await fixture.server.harness.getTask(generation, context)
  expect(run?.kind).toBe(GenerationTask.definition.name)
  expect(run?.state).toMatchObject({
    outcome: { status: 'completed', result: { entryId: entries[0].data.answerId } },
  })
  expect((await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
  const view = await fixture.conversation.context(context)
  expect(JSON.stringify(view.messages)).not.toContain('Added concise summaries')
})

it.each(['answers', 'fails'] as const)(
  'follows an older follow-up delivered after a newer steer when it %s, live and after reopen',
  async (outcome) => {
    const fixture = await launch({ own: true })
    const { server } = fixture
    let release!: () => void
    let holding = false
    server.host.registry.install(
      defineExtension({
        name: 'order-hold',
        tools: [
          defineTool({
            name: 'order_hold',
            description: 'Hold work until released',
            parameters: Type.Object({}),
            execute: async (_args, _api, toolContext) => {
              holding = true
              await awaitWithContext(new Promise<void>((done) => (release = done)), toolContext)
              return { output: [{ type: 'text', text: 'Released' }] }
            },
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('order_hold', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Steered answer.'),
      outcome === 'answers'
        ? fauxAssistantMessage('Follow-up answer.')
        : fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: 'invalid_request_error: deterministic fixture failure',
          }),
    ])
    const first = await fixture.conversation.submit({ type: 'input', content: 'Start' }, context)
    await until(() => holding)
    const followUp = await fixture.conversation.submit(
      { type: 'input', content: 'Follow up' },
      context,
    )
    const steer = await fixture.conversation.submit(
      { type: 'input', content: 'Steer', whenBusy: 'steer' },
      context,
    )
    release()
    await first.wait(context)
    const later = await followUp.wait(context)
    const steered = await steer.wait(context)
    await server.harness.waitForIdle(context)
    // The newer steer joined the first run; the older follow-up was placed after it.
    expect(steer.id).toBeGreaterThan(followUp.id)
    expect(steered.status).toBe('done')
    expect(later.entry).toBeGreaterThan(steered.entry!)
    expect(later.status).toBe(outcome === 'answers' ? 'done' : 'unanswered')
    const row = async () =>
      (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
        ?.conversations[fixture.conversation.id]
    const want =
      outcome === 'answers'
        ? {
            runState: 'answered',
            inputId: later.entry,
            answerId: later.answer,
            activity: 'Added concise summaries to the sidebar.',
            assessmentStatus: 'ready',
          }
        : { runState: 'error', inputId: later.entry }
    const expected = async () => {
      await until(async () => (await row())?.runState === want.runState)
      expect(await row()).toMatchObject(want)
    }
    await until(async () =>
      Object.values((await fixture.server.harness.inspect(context)).tasks).every(
        (task) => task.record.kind !== 'conversations.summary',
      ),
    )
    await expected()
    await fixture.server.harness.commit(async (tx) => {
      ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations = {}
    }, context)
    await fixture.reopen()
    await expected()
  },
)
