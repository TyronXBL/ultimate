import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Messages } from '../extensions/messages/api.ts'
import { fauxServer, sourceCopy, temp, removeTemp, post } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
export const servers: Server[] = []
const homes: string[] = []
// Each test runs on its own server; close them all once the file is done.
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})
function textOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : ((content as { type: string; text?: string }[]) ?? [])
        .flatMap((p) => (p.type === 'text' ? [p.text!] : []))
        .join('')
}
export async function fixture(onRequest?: (text: string, home: string) => Promise<void>) {
  const home = await temp('ultimate-agent-')
  homes.push(home)
  const root = await sourceCopy(home)
  // The repository's coordinator overlay pins a Claude Code model no test can run; tests pin their own.
  await rm(join(root, '.ultimate/agents/coordinator.md'))
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\ntools: [message]\n---\nAnswer concisely.',
  )
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  // @ultimate's definition names web_search and web_fetch, which come with the default-off parallel.
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['parallel'] } }),
  )
  const requests: string[] = []
  const open = async () => {
    const server = await fauxServer({
      ultimateRoot: root,
      home: join(home, 'state'),
      userHome: home,
      // The first model is the default; the second reasons, so a definition can pin a thinking level.
      faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-think', reasoning: true }] }),
    })
    servers.push(server)
    const route: FauxResponseFactory = async (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      const text = textOf(last.content)
      requests.push(text)
      await onRequest?.(text, home)
      if (last.role === 'user' && text.startsWith('BRANCH '))
        return fauxAssistantMessage([fauxToolCall('branch', JSON.parse(text.slice(7)))], {
          stopReason: 'toolUse',
        })
      if (last.role === 'user' && text.startsWith('CODE '))
        return fauxAssistantMessage([fauxToolCall('codemode', { code: text.slice(5) })], {
          stopReason: 'toolUse',
        })
      if (last.role === 'user' && text.startsWith('SEND '))
        return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
          stopReason: 'toolUse',
        })
      return fauxAssistantMessage(
        last.role === 'toolResult' ? `Tool result: ${text}` : `Answer: ${text}`,
      )
    }
    server.host.faux!.setResponses([route])
    return server
  }
  const server = await open()
  const subagents = {
    standing: async (name: string, _ctx: typeof context) => {
      const response = await post(server, '/api/extensions/subagents/actions/standing', {
        args: { name },
      })
      expect(response.status).toBe(200)
      return response.data.result as ConversationId
    },
  }
  return { home, root, server, subagents, requests, open }
}
/** A model Pi knows, on a provider with no login in tests. */
export const dead = 'anthropic/claude-opus-5.5'
export async function entries(server: Server, id: ConversationId) {
  return server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: id }, 1000)).items,
    context,
  )
}
export async function log(server: Server) {
  return (await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages ?? []
}
export async function ask(server: Server, id: ConversationId, text: string) {
  const conversation = (await server.harness.conversation(id, context))!
  await (await conversation.submit({ type: 'input', content: text }, context)).wait(context)
}
