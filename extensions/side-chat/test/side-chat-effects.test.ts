import { describe, expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Messages } from '../../messages/api.ts'
import { Side } from '../server.ts'
import { fauxServer, post, until } from '../../../test/helpers.ts'
import { ultimateRoot, servers, fixture, entries } from './side-chat-fixture.ts'

describe('side chats', () => {
  it('tracks only the specified tool/actions before execution, including failures, and persists effects across reopen', async () => {
    const f = await fixture()
    const side = await f.open()
    await f.call(side, 'todo', { action: 'list' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(false)
    // A side chat keeps @ultimate's to-dos as main.
    await f.call(side, 'todo', { action: 'add', text: 'from the side', owner: 'user' })
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Added 1 for user: from the side',
    )
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    await f.call(side, 'message', { to: 'user', text: 'must fail' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Only @ultimate and branches message the user',
    )
    expect((await f.action('discard', { id: side })).data.error).toMatch(/has effects/)
    servers.splice(servers.indexOf(f.server), 1)
    await f.server.close()
    const reopened = await fauxServer({ ultimateRoot, home: f.home, userHome: f.home })
    servers.push(reopened)
    expect((await reopened.harness.snapshot(Side, side, context))!.effects).toBe(true)
    const refused = await post(reopened, '/api/extensions/side-chat/actions/discard', {
      args: { id: side },
      conversationId: f.main,
    })
    expect(refused.data.error).toMatch(/has effects/)
  })

  it('attributes messages and notes to main, returns replies there, refuses messaging self/user, and leaves one provenance note', async () => {
    const f = await fixture()
    const target = await f.server.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: (await f.server.root.agent(context)).model },
      },
      context,
    )
    const side = await f.open()
    await f.call(side, 'note', { to: target.id, text: 'a note' })
    expect((await f.server.harness.snapshot(Side, side, context))!.effects).toBe(true)
    const note = (await entries(f.server, target.id)).find(
      (entry) => entry.kind === 'lineage.note',
    )!
    expect(note.data).toMatchObject({ from: f.main, text: 'a note' })
    await f.call(side, 'message', { to: `#${target.id}`, text: 'one question', reply: true })
    await until(async () => {
      const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
      return board.messages.some((message) => message.from === target.id && message.to === f.main)
    })
    const board = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
    expect(board.messages.find((message) => message.text === 'one question')).toMatchObject({
      from: f.main,
      to: target.id,
      reply: true,
    })
    expect(board.messages.filter((message) => message.to === side)).toEqual([])
    const provenance = (await entries(f.server, f.main)).filter(
      (entry) =>
        entry.kind === 'lineage.note' &&
        JSON.stringify(entry.data).includes(`Side chat #${side} messaged`),
    )
    expect(provenance).toHaveLength(1)
    await f.call(side, 'message', { to: '@ultimate', text: 'self' })
    expect(JSON.stringify(await entries(f.server, side))).toContain('You cannot message yourself')
    await f.call(side, 'message', { to: 'user', text: 'user' })
    expect(JSON.stringify(await entries(f.server, side))).toContain(
      'Only @ultimate and branches message the user',
    )
  })

  // Each tool resolves images on its own path; `latest` and entry ids are messages.test.ts's "forwards images from the sender".
  it.each([
    ['message', 'latest'],
    ['branch', 'entry'],
  ] as const)(
    'forwards the side chat image for %s with %s, not main’s image',
    async (tool, ref) => {
      const f = await fixture()
      const side = await f.open()
      const image = {
        type: 'image' as const,
        data: Buffer.from('side').toString('base64'),
        mimeType: 'image/png',
      }
      const appendImage = (id: ConversationId, data: string) =>
        f.server.harness.commit(
          (tx) =>
            tx.appendEntry(id, {
              kind: 'pi.tool-result',
              model: [
                {
                  role: 'toolResult',
                  toolCallId: 'screenshot',
                  toolName: 'screenshot',
                  isError: false,
                  content: [{ ...image, data }],
                  timestamp: Date.now(),
                },
              ],
            }),
          context,
        )
      await appendImage(f.main, Buffer.from('main').toString('base64'))
      const target = await f.server.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        context,
      )
      const text = `image ${tool} ${ref}`
      const args =
        tool === 'branch'
          ? { prompt: text, root: ROOT_CONVERSATION_ID, isolated: false }
          : { to: `#${target.id}`, text, reply: false }
      let screenshot: { id: number }
      if (ref === 'latest') {
        // "latest" forwards this turn's images: the side chat's own input carries the screenshot.
        const submission = await (await f.server.harness.conversation(side, context))!.submit(
          {
            type: 'input',
            content: [
              {
                type: 'text',
                text: `CALL ${JSON.stringify({ name: tool, args: { ...args, images: ref } })}`,
              },
              image,
            ],
          },
          context,
        )
        await submission.wait(context)
        screenshot = { id: (await submission.status(context)).entry! }
      } else {
        screenshot = await appendImage(side, image.data)
        await f.call(side, tool, { ...args, images: screenshot.id })
      }
      await until(async () =>
        (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.some(
          (message) => message.text === text && message.entry !== undefined,
        ),
      )
      const sent = (await f.server.harness.snapshot(
        Messages,
        ROOT_CONVERSATION_ID,
        context,
      ))!.messages.find((message) => message.text === text)!
      expect(sent).toMatchObject({ from: f.main, images: { entry: screenshot.id, count: 1 } })
      const delivered = (await entries(f.server, sent.to as number)).find(
        (entry) => entry.id === sent.entry,
      )!
      expect(
        delivered.model!.flatMap((message) =>
          typeof message.content === 'string'
            ? []
            : message.content.filter((block) => block.type === 'image'),
        ),
      ).toEqual([image])
    },
  )
})
