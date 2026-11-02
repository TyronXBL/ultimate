import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, expect } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { fauxServer, post, sourceCopy, temp, unusedExtensions } from './helpers.ts'

export let ultimateRoot: string
export const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  // A watcher that inherits faux and only answers: creation must not launch a real script.
  await writeFile(
    join(ultimateRoot, 'agents/watcher.md'),
    '---\nname: watcher\ndescription: Test automation writer\ntools: [read]\n---\nAnswer without writing or starting any script.\n',
  )
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
})
// Each test's servers close when it ends: closing every test's servers at once overruns the hook timeout under load.
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content) && content[0]?.type === 'text'
      ? content[0].text
      : JSON.stringify(content)

export async function fixture() {
  const home = await temp('ultimate-sidechat-')
  // Only the extensions side chats use beyond the core tier, in user settings: tests rewrite the project's.
  const disable = await unusedExtensions(ultimateRoot, [
    'side-chat',
    'automations',
    'codemode',
    'todos',
  ])
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable } }),
  )
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  expect(standing.status).toBe(200)
  const main = standing.data.result as ConversationId
  const hold = Promise.withResolvers<void>()
  const gate = { afterTool: false, entered: false, summaryFailure: undefined as string | undefined }
  const requests: { system: string; text: string; messages: string }[] = []
  const summaries: string[] = []
  const route: FauxResponseFactory = async (transcript, options) => {
    server.host.faux!.appendResponses([route])
    const system = transcript.messages
      .filter((message) => message.role === 'system')
      .map((message) =>
        JSON.stringify({
          content: message.content,
          sections: message.sections,
          toolsAdded: message.toolsAdded,
          toolsRemoved: message.toolsRemoved,
        }),
      )
      .join('\n')
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text = textOf(last.content)
    requests.push({ system, text, messages: JSON.stringify(transcript.messages) })
    if (system.includes('Summarize this temporary side chat')) {
      summaries.push(text)
      if (gate.summaryFailure)
        return fauxAssistantMessage(gate.summaryFailure, {
          stopReason: 'error',
          errorMessage: gate.summaryFailure,
        })
      return fauxAssistantMessage('Decision: keep the finding. Open question: next step?')
    }
    if (last.role === 'toolResult') {
      if (gate.afterTool) {
        gate.entered = true
        await hold.promise
      }
      return fauxAssistantMessage(`Tool result: ${text}`)
    }
    if (text === 'HOLD')
      await Promise.race([
        hold.promise,
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      ])
    if (text.startsWith('CALL ')) {
      const { name, args } = JSON.parse(text.slice(5))
      return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage(`echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  const ask = async (id: number, text: string) =>
    (
      await (await server.harness.conversation(id as ConversationId, context))!.submit(
        { type: 'input', content: text },
        context,
      )
    ).wait(context)
  await ask(main, 'MAIN HISTORY')
  const action = (name: string, args: unknown, conversationId = main) =>
    post(server, `/api/extensions/side-chat/actions/${name}`, { args, conversationId })
  const open = async (text = 'TANGENT') => {
    const result = await action('open', { text })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    const id = result.data.result.id as ConversationId
    await (await server.harness.conversation(id, context))!.waitForIdle(context)
    return id
  }
  const call = (id: number, name: string, args: unknown) =>
    ask(id, `CALL ${JSON.stringify({ name, args })}`)
  return { server, main, home, hold, gate, requests, summaries, ask, action, open, call }
}

export async function entries(server: Awaited<ReturnType<typeof fauxServer>>, id: number) {
  return server.harness.commit(
    async (tx) =>
      (await tx.scanEntries({ conversationId: id as ConversationId, order: 'ascending' }, 1000))
        .items,
    context,
  )
}
