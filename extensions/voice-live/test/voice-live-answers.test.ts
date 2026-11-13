import { expect, it, vi } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Messages } from '../../messages/api.ts'
import { Standing } from '../../subagents/api.ts'
import { Summaries } from '../../conversations/summary.ts'
import type { VoiceAnswer, VoiceLine } from '../refs.ts'
import { post, until } from '../../../test/helpers.ts'
import { fixture } from './voice-live-fixture.ts'

it('answers a connection check itself in the standing Voice conversation, with its relay tools and codemode', async () => {
  const f = await fixture()
  expect((await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice).toBe(
    f.voice,
  )
  const agent = await (await f.server.harness.conversation(f.voice, context))!.agent(context)
  expect(agent.tools.map((t) => t.name).toSorted()).toEqual([
    'codemode',
    'voice_answer',
    'voice_ask_ultimate',
    'voice_note',
    'voice_question',
    'voice_say',
    'voice_show',
  ])
  expect((await f.server.harness.snapshot(Summaries, f.voice, context))?.automatic).toBe(false)
  await f.action('heard', { text: 'can you hear me' })
  await until(async () => (await f.entries(f.voice)).some((e) => e.kind === 'voice.line'))
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  expect(lines.map((e) => e.data)).toEqual([
    { role: 'ultimate', text: 'Yes, I can hear you.', speech: true },
  ])
  expect((await f.entries(f.voice)).find((e) => e.kind === 'voice.heard')?.data).toEqual({
    text: 'can you hear me',
  })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(0)
})

it('forwards the cleaned request and feeds the actual answer back to Voice to speak, linked to its forwarded line', async () => {
  const f = await fixture()
  await f.action('heard', { text: 'Um please, can you check the tests for me' })
  const spoken = await f.waitAnswer(1)
  const forwarded = (await f.entries(f.voice)).find(
    (e) => e.kind === 'voice.line' && (e.data as VoiceLine).forwarded,
  )!
  expect(forwarded.data).toEqual({
    role: 'user',
    forwarded: true,
    text: 'Please check the tests.',
    at: expect.any(Number),
  })
  expect((await f.entries(f.main)).find((e) => e.kind === 'voice.utterance')?.data).toEqual({
    text: 'Please check the tests.',
    line: forwarded.id,
  })
  expect(f.answers).toEqual([
    `@ultimate answered (to forwarded line ${forwarded.id}):\nThe tests pass.`,
  ])
  // The card's "Open in @ultimate" lands on the answer itself.
  const answer = (await f.entries(f.voice)).find((e) => e.kind === 'voice.answer')!
  const source = (answer.data as VoiceAnswer).source!
  expect(source.conversation).toBe(f.main)
  expect((await f.entries(f.main)).find((e) => e.id === source.entry)?.kind).toBe('pi.assistant')
  expect(spoken.data).toEqual({
    role: 'ultimate',
    text: 'The spoken answer. Details are on screen.',
    speech: true,
    re: forwarded.id,
  })
  await f.action('end', { seconds: 23 })
  expect((await f.entries(f.voice)).at(-1)?.data).toMatchObject({ phase: 'ended', seconds: 23 })
})

it('speaks a tool-terminated question and answers it through Messages, without a new utterance', async () => {
  const f = await fixture()
  f.setAnswer('QUESTION')
  await f.action('heard', { text: 'Please propose an approach' })
  await f.waitAnswer(1)
  const log = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  const question = log.messages.findLast((m) => m.from === f.main && m.to === 'user')!
  expect(question.state).toBe('delivered')
  expect(f.answers[0]).toContain('Which approach?')
  expect(f.answers[0]).toContain('a: Small fix')
  expect(f.answers[0]).toContain('b: Rewrite')
  f.setAnswer('I will use the small fix.')
  // Voice names the card it answers; @ultimate's reply to it comes back to Voice to speak.
  await f.action('heard', { text: `answer message ${question.id}: The small fix please` })
  await f.waitAnswer(2)
  expect(f.answers[1]).toContain('I will use the small fix.')
  expect(
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages.find(
      (m) => m.id === question.id,
    )?.state,
  ).toBe('answered')
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(1)
  expect((await f.entries(f.main)).some((e) => e.kind === 'board.message')).toBe(true)
})

it('announces a branch question that opens during a session and settles exactly the card Voice names', async () => {
  const f = await fixture()
  const messages = async () =>
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages
  // Two branch questions are open: the one Voice names is answered, the other stays (#576596: a question that
  // arrived mid-session went unannounced, and a spoken answer only reached a card when exactly one was open).
  const ask = (text: string) =>
    f.server.harness.commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      const id = log.next++
      log.messages.push({
        id,
        from: f.voice,
        to: 'user',
        text,
        at: Date.now(),
        reply: true,
        state: 'delivered',
        questions: [{ ref: '1', text, kind: 'confirm' }],
      })
      return id
    }, context)
  const first = await ask('Ship it?')
  const second = await ask('Rename it?')
  await f.action('asked', { message: second })
  await f.action('asked', { message: second })
  await until(() => f.announced.length === 1)
  expect(f.announced[0]).toContain(`message ${second}`)
  expect((await f.entries(f.voice)).filter((e) => e.kind === 'voice.question')).toHaveLength(1)
  await f.action('heard', { text: `answer message ${second}: 1. yes` })
  await until(async () => (await messages()).find((m) => m.id === second)?.state === 'answered')
  const states = Object.fromEntries((await messages()).map((m) => [m.id, m.state]))
  expect([states[first], states[second]]).toEqual(['delivered', 'answered'])
  expect((await messages()).find((m) => m.from === 'user')).toMatchObject({
    re: second,
    text: '1. yes',
  })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(0)
})

it('briefs each session, waits for the brief before the first line, and lets only the newest reach Voice', async () => {
  const f = await fixture()
  const briefs = async () => (await f.entries(f.voice)).filter((e) => e.kind === 'voice.context')
  await until(async () => (await briefs()).length === 1)
  expect((await briefs())[0].data).toMatchObject({ requests: 0, branches: 0, transient: true })
  expect((await briefs())[0].model?.[0]).toMatchObject({ role: 'user' })
  // @ultimate gets a request, then a second session starts while its brief is held back.
  await f.action('heard', { text: 'please check the tests' })
  await f.waitAnswer(1)
  const gate = Promise.withResolvers<void>()
  const conversation = f.server.harness.conversation.bind(f.server.harness)
  let opened = 0
  const spy = vi.spyOn(f.server.harness, 'conversation').mockImplementation(async (id, ctx) => {
    const found = await conversation(id, ctx)
    if (id === f.voice) opened++
    if (id !== f.main || !found) return found
    return Object.assign(Object.create(found), {
      entries: async (...args: Parameters<typeof found.entries>) => {
        await gate.promise
        return found.entries(...args)
      },
    })
  })
  try {
    await f.startSession()
    const before = opened
    const snapshot = f.server.harness.snapshot.bind(f.server.harness)
    const receiving = Promise.withResolvers<void>()
    const snapshotSpy = vi
      .spyOn(f.server.harness, 'snapshot')
      .mockImplementation(async (...args) => {
        const value = await snapshot(...args)
        if (args[0].definition.kind === Standing.definition.kind) receiving.resolve()
        return value
      })
    try {
      const heard = f.action('heard', { text: 'what was that about' })
      await receiving.promise
      // The heard action has read its recipient but the held brief keeps the line out of Voice's conversation.
      expect((await f.entries(f.voice)).filter((e) => e.kind === 'voice.heard')).toHaveLength(1)
      expect(opened).toBe(before)
      gate.resolve()
      await heard
    } finally {
      snapshotSpy.mockRestore()
    }
  } finally {
    gate.resolve()
    spy.mockRestore()
  }
  const all = await f.entries(f.voice)
  const second = all.filter((e) => e.kind === 'voice.context')[1]
  const line = all.findLast((e) => e.kind === 'voice.heard')!
  expect(second.id).toBeLessThan(line.id)
  expect(second.data).toMatchObject({ requests: 1 })
  expect((second.data as { text: string }).text).toContain('Please check the tests.')
  expect(second.edits).toEqual([{ target: (await briefs())[0].id, action: 'omit' }])
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  // Voice's request on that line carries the new brief once, and not the old one.
  const seen = f.requests.at(-1)!.filter((m) => m.startsWith('<voice_context>'))
  expect(seen).toEqual([(second.data as { text: string }).text])
})

it('shows OpenAI’s own reason when it refuses a session, never a bare HTTP status or the key', async () => {
  const f = await fixture()
  const original = globalThis.fetch
  const sessions = 'https://api.openai.com/v1/live/sessions'
  // OpenAI's real 429 for an account with no credits, whose reason a bare status threw away. The second answer is a
  // proxy page instead of OpenAI's JSON, which leaves only the status to report.
  const answers = [
    () =>
      Response.json(
        {
          error: {
            message:
              'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
        { status: 429 },
      ),
    () => new Response('<html>bad gateway</html>', { status: 502 }),
  ]
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((url, init) =>
      url === sessions ? Promise.resolve(answers.shift()!()) : original(url, init),
    )
  const start = () =>
    post(f.server, '/api/extensions/voice-live/actions/start', { args: { sdp: 'fake-offer' } })
  try {
    const refused = await start()
    expect(refused.status).not.toBe(200)
    expect(refused.data.error).toContain(
      'OpenAI live session failed (HTTP 429 insufficient_quota): You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/',
    )
    expect(refused.data.error).not.toContain('sk-test-not-real')
    expect((await start()).data.error).toContain('OpenAI live session failed (HTTP 502)')
  } finally {
    fetch.mockRestore()
  }
})
