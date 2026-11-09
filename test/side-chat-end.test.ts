import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Index, Side } from '../extensions/side-chat/server.ts'
import type { endTask } from '../extensions/side-chat/server.ts'
import { transition } from '../extensions/side-chat/logic.ts'
import { fauxServer, post, until } from './helpers.ts'
import { ultimateRoot, servers, fixture, entries } from './side-chat-fixture.ts'

describe('side chats', () => {
  it.each([
    [
      { state: 'open' },
      { type: 'begin', mode: 'discarded' },
      { state: 'ending', mode: 'discarded' },
    ],
    [{ state: 'open' }, { type: 'begin', mode: 'injected' }, { state: 'ending', mode: 'injected' }],
    [
      { state: 'ending', mode: 'discarded' },
      { type: 'complete' },
      { state: 'ended', mode: 'discarded' },
    ],
    [
      { state: 'ending', mode: 'injected' },
      { type: 'complete' },
      { state: 'ended', mode: 'injected' },
    ],
    // A failed inject's summary reopens the copy for a retry (34c3633c).
    [{ state: 'ending', mode: 'injected' }, { type: 'rollback' }, { state: 'open' }],
    // An ending whose task faulted can be ended again either way (PR #103).
    [{ state: 'ending', mode: 'discarded' }, { type: 'faulted' }, { state: 'open' }],
  ] as const)('transitions side-chat lifecycle %j', (from, event, expected) => {
    expect(transition(from, event)).toEqual(expected)
  })

  it.each([
    [
      { state: 'ending', mode: 'discarded' },
      { type: 'begin', mode: 'injected' },
    ],
    [
      { state: 'ended', mode: 'injected' },
      { type: 'begin', mode: 'injected' },
    ],
    [{ state: 'open' }, { type: 'complete' }],
    [{ state: 'ending', mode: 'discarded' }, { type: 'rollback' }],
    [{ state: 'ended', mode: 'injected' }, { type: 'faulted' }],
  ] as const)('%j refuses %j', (from, event) => {
    expect(() => transition(from, event)).toThrow(/ended or ending|not ending|Only an inject/)
  })

  it('discards without writing main, concludes, refuses repeated end and later input, and refuses inject without summaryModel', async () => {
    const f = await fixture()
    const side = await f.open()
    expect((await f.action('inject', { id: side })).data.error).toContain('summaryModel')
    const before = await entries(f.server, f.main)
    expect((await f.action('discard', { id: side })).status).toBe(200)
    expect(await entries(f.server, f.main)).toEqual(before)
    expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('discarded')
    expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(side)
    expect((await f.action('discard', { id: side })).data.error).toMatch(/already ended/)
    await expect(f.ask(side, 'revive')).rejects.toThrow(/has ended/)
    expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(side)
  })

  it('reopens after a summary-model failure, reports its error, and admits exactly one summary on retry', async () => {
    const f = await fixture()
    const side = await f.open('FAILED SUMMARY FINDING')
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      f.gate.summaryFailure = 'provider rate limit'
      const failed = await f.action('inject', { id: side })
      expect(failed.status).toBe(500)
      expect(failed.data.error).toContain('provider rate limit')
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(0)
      expect(await f.server.harness.snapshot(Side, side, context)).toMatchObject({ effects: false })
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBeUndefined()
      await f.ask(side, 'continue after failed inject')
      f.gate.summaryFailure = undefined
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      // A failed attempt with no effects also leaves Discard usable.
      const discardable = await f.open()
      f.gate.summaryFailure = 'another model failure'
      expect((await f.action('inject', { id: discardable })).status).toBe(500)
      expect((await f.action('discard', { id: discardable })).status).toBe(200)
    } finally {
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('lets a side chat whose ending task faulted be injected or discarded again', async () => {
    const f = await fixture()
    const side = await f.open('FAULTED ENDING FINDING')
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    // The task throws after the summary, where a failure of main's admission faults it (not a model failure).
    const harness = f.server.harness
    const conversation = harness.conversation.bind(harness)
    let fault = false
    harness.conversation = async (id, ctx) => {
      if (fault && id === f.main) throw new RangeError('stdout maxBuffer length exceeded')
      return conversation(id, ctx)
    }
    try {
      fault = true
      const failed = await f.action('inject', { id: side })
      expect(failed.status).toBe(500)
      expect(failed.data.error).toContain(`Could not end side chat #${side}`)
      expect(failed.data.error).toContain('maxBuffer')
      fault = false
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      const discardable = await f.open()
      fault = true
      expect((await f.action('inject', { id: discardable })).status).toBe(500)
      fault = false
      expect((await f.action('discard', { id: discardable })).status).toBe(200)
      expect((await f.server.harness.snapshot(Side, discardable, context))!.ended).toBe('discarded')
    } finally {
      harness.conversation = conversation
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('queues the passive summary in a busy main without starting a run, then reads it with the next input', async () => {
    const f = await fixture()
    const side = await f.open('BUSY MAIN FINDING')
    const running = await (await f.server.harness.conversation(f.main, context))!.submit(
      { type: 'input', content: 'HOLD' },
      context,
    )
    await until(() => f.requests.some((request) => request.text === 'HOLD'))
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      const before = f.requests.length
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(0)
      // Only the summary model ran; main is still working on the same HOLD input.
      expect(f.requests).toHaveLength(before + 1)
      f.hold.resolve()
      await running.wait(context)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      await f.ask(f.main, 'FOLLOW UP')
      expect(f.requests.findLast((request) => request.text === 'FOLLOW UP')!.messages).toContain(
        `Side chat #${side} (forked at`,
      )
    } finally {
      f.hold.resolve()
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('replays after write admission and before conclusion without asking the model or writing a second summary', async () => {
    const f = await fixture()
    const side = await f.open('CRASH FINDING')
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      const reached = Promise.withResolvers<void>()
      const extension = f.server.host.registry.snapshot().extension('side-chat')!
      const original = extension.tasks!.find(
        (task) => task.definition.name === 'side-chat.end',
      )! as ReturnType<typeof endTask>
      const definition = original.definition
      const interrupted = defineTask({
        ...definition,
        phases: {
          ...definition.phases,
          summarize: (task, runtime, ctx) =>
            definition.phases.summarize(
              task,
              {
                ...runtime,
                commit: async () => {
                  // The write has been admitted; die before the concluding commit, leaving summarize replayable.
                  reached.resolve()
                  await new Promise<void>((_resolve, reject) =>
                    runtime.signal.addEventListener('abort', () =>
                      reject(new Error('simulated crash')),
                    ),
                  )
                },
              },
              ctx,
            ),
        },
      })
      f.server.host.registry.install(
        defineExtension({
          ...extension,
          tasks: extension.tasks!.map((task) => (task === original ? interrupted : task)),
        }),
      )
      const pending = f.action('inject', { id: side }).catch((error: unknown) => error)
      await reached.promise
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBeUndefined()
      expect(f.summaries).toHaveLength(1)
      servers.splice(servers.indexOf(f.server), 1)
      await f.server.close()
      await pending
      const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
      servers.push(reopened)
      let asked = 0
      reopened.host.faux!.setResponses([
        () => {
          asked++
          return fauxAssistantMessage('must not ask again')
        },
      ])
      const result = await post(reopened, '/api/extensions/side-chat/actions/inject', {
        args: { id: side },
        conversationId: f.main,
      })
      expect([result.status, result.data.error]).toEqual([200, undefined])
      expect(asked).toBe(0)
      expect(
        (await entries(reopened, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
      expect((await reopened.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      expect((await reopened.host.uiState(context))['ext.conversations.concluded']).toContain(side)
    } finally {
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })

  it('aborts a running copy, memoizes only its new entries, and injects exactly one passive summary even when requested twice', async () => {
    const f = await fixture()
    const side = await f.open('SIDE FINDING')
    // Project settings are read afresh when the summary is requested.
    await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
    try {
      const mainBefore = f.requests.filter((request) => request.text === 'MAIN HISTORY').length
      const copy = (await f.server.harness.conversation(side, context))!
      await copy.submit({ type: 'input', content: 'HOLD' }, context)
      await until(() => f.requests.some((request) => request.text === 'HOLD'))
      const [a, b] = await Promise.all([
        f.action('inject', { id: side }),
        f.action('inject', { id: side }),
      ])
      expect([a.status, b.status, a.data.error, b.data.error]).toEqual([
        200,
        200,
        undefined,
        undefined,
      ])
      const summaries = (await entries(f.server, f.main)).filter(
        (entry) => entry.kind === 'sidechat.summary',
      )
      expect(summaries).toHaveLength(1)
      expect(summaries[0].data).toMatchObject({
        side,
        from: side,
        to: f.main,
        text: expect.stringContaining('Decision:'),
      })
      expect(f.summaries).toHaveLength(1)
      expect(f.summaries[0]).toContain('SIDE FINDING')
      expect(f.summaries[0]).not.toContain('MAIN HISTORY')
      expect((await f.server.harness.snapshot(Side, side, context))!.ended).toBe('injected')
      expect((await f.server.host.uiState(context))['ext.conversations.concluded']).toContain(side)
      expect((await f.server.harness.snapshot(Index, f.main, context))!.sides[0].ended).toBe(
        'injected',
      )
      expect(f.requests.filter((request) => request.text === 'MAIN HISTORY')).toHaveLength(
        mainBefore,
      )
      const live = await f.server.harness.inspect(context)
      expect(
        live.tasks.filter(
          (task) => task.record.conversationId === f.main && !task.record.background,
        ),
      ).toHaveLength(0)
      await expect(f.ask(side, 'revive')).rejects.toThrow(/has ended/)
      expect((await f.action('inject', { id: side })).status).toBe(200)
      expect(
        (await entries(f.server, f.main)).filter((entry) => entry.kind === 'sidechat.summary'),
      ).toHaveLength(1)
    } finally {
      await writeFile(
        join(ultimateRoot, '.ultimate/settings.json'),
        JSON.stringify({ summaryModel: 'unavailable/test' }),
      )
    }
  })
})
