import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, JsonObject } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { setAutomaticSummaries } from '../../conversations/summary.ts'
import { liveInstructions } from '../server.ts'
import type { VoiceLine } from '../refs.ts'
import { writeSecret } from '../../secrets/store.ts'
import { fauxServer, held, post, sourceCopy, temp, until } from '../../../test/helpers.ts'

export let ultimateRoot: string
export const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  const path = join(ultimateRoot, 'extensions/voice-live/agents/voice.md')
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace('openai-codex/gpt-6-luna', 'faux/faux-1'),
  )
  await settleProbe(ultimateRoot)
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['voice-live'] } }),
  )
})
// Settles a question through Messages under a tool call's receipt, as the interrupted first run of `voice_answer` did.
async function settleProbe(root: string) {
  const dir = join(root, 'extensions/settle-probe')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'server.ts'),
    `import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { MessagesApi } from ${JSON.stringify(resolve('extensions/messages/api.ts'))}
export const actions = {
  settle: ({ message, text, call }, { host }) =>
    text === undefined
      ? host.need(MessagesApi).dismiss(message, BACKGROUND_CONTEXT, undefined, call)
      : host.need(MessagesApi).answer(message, text, BACKGROUND_CONTEXT, undefined, call),
}
export default { name: 'settle-probe' }
`,
  )
}
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

export async function fixture() {
  const home = await temp('ultimate-voice-live-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  expect(standing.status).toBe(200)
  const main = standing.data.result as ConversationId
  await server.harness.commit((tx) => setAutomaticSummaries(tx, main, false), context)
  await until(
    async () =>
      (await post(server, '/api/extensions/automations/actions/list', { args: null })).data.result
        .length > 0,
  )
  await writeSecret(home, 'OPENAI_API_KEY', 'sk-test-not-real')
  let sessions = 0
  const startSession = async () => {
    const originalFetch = globalThis.fetch
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
      url === 'https://api.openai.com/v1/live/sessions'
        ? Promise.resolve(
            Response.json({
              session: { id: `fake-live-${++sessions}` },
              transport: { type: 'webrtc', sdp: 'fake-answer' },
            }),
          )
        : originalFetch(url, init),
    )
    try {
      const result = await post(server, '/api/extensions/voice-live/actions/start', {
        args: { sdp: 'fake-offer' },
      })
      expect([result.status, result.data.error]).toEqual([200, undefined])
      const [, request] = fetch.mock.calls.find(
        ([target]) => target === 'https://api.openai.com/v1/live/sessions',
      )!
      expect(JSON.parse(request!.body as string).session.instructions).toBe(liveInstructions())
      return result.data.result.conversation as ConversationId
    } finally {
      fetch.mockRestore()
    }
  }
  const voice = await startSession()
  const requests: string[][] = []
  const answers: string[] = []
  const announced: string[] = []
  let answer = 'The tests pass.'
  const call = (name: string, args: JsonObject) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
  const route: FauxResponseFactory = (...args) => {
    const [transcript] = args
    server.host.faux!.appendResponses([route])
    const system = JSON.stringify(transcript.messages.filter((m) => m.role === 'system'))
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    if (system.includes('You are the voice in the user')) {
      requests.push(
        transcript.messages.flatMap((m) =>
          m.role === 'user' && typeof m.content === 'string' ? [m.content] : [],
        ),
      )
      if (text.startsWith('A new question for the user arrived')) {
        announced.push(text)
        return call('voice_say', { text: 'A branch has a question. Want it now?' })
      }
      if (last.role === 'toolResult' && last.toolName === 'voice_answer')
        return call('voice_say', { text: 'Sent. Nothing else waits.' })
      if (last.role === 'toolResult') return call('voice_say', { text: 'Passing that on.' })
      const settle = /^.*answer message (\d+): (.+)$/s.exec(text)
      if (settle)
        return call('voice_answer', { message: Number(settle[1]), text: settle[2].trim() })
      if (text.startsWith('@ultimate answered')) {
        answers.push(text)
        return call('voice_say', { text: 'The spoken answer. Details are on screen.' })
      }
      if (text.includes('can you hear me'))
        return call('voice_say', { text: 'Yes, I can hear you.' })
      return call('voice_ask_ultimate', {
        request: text.includes('small fix') ? 'Use the small fix.' : 'Please check the tests.',
      })
    }
    if (answer === 'QUESTION')
      return call('message', {
        to: 'user',
        text: 'Which approach?',
        questions: [
          {
            ref: '1',
            text: 'Approach?',
            kind: 'choice',
            options: [
              { key: 'a', label: 'Small fix' },
              { key: 'b', label: 'Rewrite' },
            ],
          },
        ],
      })
    if (answer === 'HOLD') return held(...args)
    return fauxAssistantMessage(answer)
  }
  server.host.faux!.setResponses([route])
  const action = async (name: string, args: unknown) => {
    const result = await post(server, `/api/extensions/voice-live/actions/${name}`, { args })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    return result.data.result
  }
  const entries = (id: ConversationId) =>
    server.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: id, order: 'ascending' }, 1000)).items,
      context,
    )
  const waitAnswer = async (count: number) => {
    await until(
      async () =>
        (await entries(voice)).filter(
          (e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined,
        ).length === count,
    )
    return (await entries(voice))
      .filter((e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined)
      .at(-1)!
  }
  return {
    server,
    main,
    voice,
    startSession,
    requests,
    action,
    entries,
    answers,
    announced,
    waitAnswer,
    setAnswer: (text: string) => {
      answer = text
    },
  }
}
