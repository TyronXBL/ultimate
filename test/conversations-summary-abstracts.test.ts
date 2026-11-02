// First: helpers mocks the faux provider's token pacing, which must apply before the server modules load.
import { until } from './helpers.ts'
import type { Models } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import { generateSummary, summaryBehavior } from '../extensions/conversations/summary.ts'
import { luna, held, launch } from './conversations-summary-fixture.ts'

it.each([false, true])(
  'does not request abstracts without a branch, lineage=%s',
  async (lineage) => {
    const fixture = await launch({ root: lineage })
    await fixture.exchange()
    expect(fixture.abstract).not.toHaveBeenCalled()
    expect(fixture.generated.mock.calls[0][7]).toBeUndefined()
    expect((await fixture.read())?.abstract).toBeUndefined()
  },
)

it('writes each branch abstract atomically with its accepted answer and reuses it next time', async () => {
  const fixture = await launch({ branch: true })
  await fixture.exchange()
  const state = await fixture.read()
  expect(fixture.abstract).toHaveBeenCalledTimes(1)
  expect(fixture.abstract.mock.calls[0].slice(1)).toEqual([
    fixture.conversation.id,
    expect.objectContaining({ at: state?.lastAnswer, text: state?.abstract }),
  ])
  expect((await fixture.entries()).filter((entry) => entry.kind === 'test.abstract')).toHaveLength(
    1,
  )
  expect(fixture.generated.mock.calls[0][1]).toContain('Improve the sidebar')
  expect(fixture.generated.mock.calls[0][7]).toBe(true)
  await fixture.exchange()
  expect(fixture.abstract).toHaveBeenCalledTimes(2)
  expect(fixture.generated.mock.calls[1][1]).toContain(`Previous abstract:\n${state?.abstract}`)
  expect(fixture.generated.mock.calls[1][3]).toBe(true)
})

it.each(['error', 'aborted'] as const)(
  'does not abstract an %s main answer',
  async (stopReason) => {
    const fixture = await launch({ branch: true })
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Unfinished.', { stopReason })])
    const submission = await fixture.conversation.submit(
      { type: 'input', content: 'Work' },
      context,
    )
    await submission.wait(context)
    await fixture.conversation.waitForIdle(context)
    await until(
      async () => Object.values((await fixture.server.harness.inspect(context)).tasks).length === 0,
    )
    expect(fixture.abstract).not.toHaveBeenCalled()
    expect((await fixture.read())?.abstract).toBeUndefined()
  },
)

it('rejects an older response after a newer scheduled summary has completed', async () => {
  // It waits until the server has no tasks at all, which other tests' background work would delay.
  const fixture = await launch({ own: true })
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await held(gate, signal)
    return {
      activity: 'Implemented the requested sidebar changes.',
      title: 'An older stale title',
      summary: 'Older stale summary.',
    }
  })
  for (let count = 1; count <= 4; count++) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (
      await fixture.conversation.submit({ type: 'input', content: `Exchange ${count}` }, context)
    ).wait(context)
    await until(async () => (await fixture.read())?.exchanges === count)
    if (count === 1) await until(() => fixture.generated.mock.calls.length === 1)
    else await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  }
  await until(async () => (await fixture.read())?.status === 'ready')
  release()
  await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
  expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.conversation.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
  expect(await fixture.titleChanges()).toHaveLength(1)
})

it.each(['reply', 'spawn'] as const)(
  'resumes pending %s generation after shutdown without a stuck checkpoint',
  async (mode) => {
    const fixture = await launch({ own: true })
    if (mode === 'spawn') await fixture.exchange()
    fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
      await new Promise((_done, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }),
      )
      throw new Error('Unreachable')
    })
    if (mode === 'spawn') await fixture.spawn((await fixture.read())!.lastAnswer!)
    else {
      fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
      await (
        await fixture.conversation.submit({ type: 'input', content: 'Summarize this' }, context)
      ).wait(context)
    }
    await until(() => fixture.generated.mock.calls.length === (mode === 'spawn' ? 2 : 1))
    await fixture.reopen()
    await until(async () => (await fixture.read())?.status === 'ready')
    expect((await fixture.read())?.exchanges).toBe(1)
    expect(fixture.generated).toHaveBeenCalledTimes(mode === 'spawn' ? 3 : 2)
    const changes = await fixture.titleChanges()
    expect(changes).toHaveLength(1)
    await fixture.reopen()
    expect(await fixture.titleChanges()).toEqual(changes)
  },
)

it.each(['none', 'legacy'])(
  'skips summaries and assessments when the chosen Codex Luna is unavailable (%s)',
  async (available) => {
    // It asserts that the whole server has no tasks left.
    const fixture = await launch({ own: true })
    const server = fixture.server
    const existing = server.host.registry.snapshot().extension('conversations')!
    const models =
      available === 'none'
        ? []
        : server.host.modelRuntime
            .getModels()
            .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna')
    expect(models).toHaveLength(available === 'none' ? 0 : 1)
    server.host.registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            userHome: server.host.userHome,
            // Chosen explicitly: only the default falls back to another available model.
            projectSettings: async () => ({ summaryModel: 'openai-codex/gpt-6-luna:medium' }),
            notice: () => {},
            modelRuntime: { getAvailableSnapshot: () => models },
          },
          fixture.generated,
        ),
      }),
    )
    server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (
      await fixture.conversation.submit({ type: 'input', content: 'Work' }, context)
    ).wait(context)
    await server.harness.waitForIdle(context)
    expect(fixture.generated).not.toHaveBeenCalled()
    expect(await fixture.titleChanges()).toEqual([])
    expect((await server.harness.inspect(context)).tasks).toHaveLength(0)
    expect((await fixture.read())?.status).toBeUndefined()
    expect((await fixture.read())?.assessmentStatus).toBeUndefined()
    expect((await fixture.read())?.exchanges ?? 0).toBe(0)
    expect(
      (await server.harness.snapshot(Overview, server.root.id, context))?.conversations[
        fixture.conversation.id
      ]?.assessmentStatus,
    ).toBeUndefined()
  },
)

it.each([
  ['  Conversation\n sidebar\t rendering extra words  ', 'Conversation sidebar rendering'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 extra words', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'],
  ['Conversation-specific Rendering UI', 'Conversation-specific Rendering'],
  ['', undefined],
  [' \n\t ', undefined],
  [null, undefined],
  [42, undefined],
  [undefined, undefined],
])('normalizes feature labels without rejecting summaries: %j', async (feature, expected) => {
  const result = await generateSummary(
    {} as Models,
    'Request',
    new AbortController().signal,
    true,
    {
      model: luna,
      response: {
        provider: luna.provider,
        model: luna.id,
        stopReason: 'stop',
        text: JSON.stringify({ title: 'Title', summary: 'Summary', feature }),
      },
    },
    'intent',
  )
  expect(result).toEqual({
    activity: '',
    title: 'Title',
    summary: 'Summary',
    ...(expected ? { feature: expected } : {}),
  })
})
