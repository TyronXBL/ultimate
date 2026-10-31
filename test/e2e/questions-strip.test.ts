// A branch's question to the user stays in the strip above @ultimate's composer until it is answered there.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { Started } from '../../extensions/messages/addresses.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it("answers a branch's question from the strip above @ultimate's composer", async () => {
  const home = await temp('ultimate-questions-strip-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
    web: true,
  })
  cleanup.push(() => server.close())
  // The branch asks the user one question on its input, and acknowledges anything else.
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    return last.role === 'user' && last.content === 'ask'
      ? fauxAssistantMessage(
          [
            fauxToolCall('message', {
              to: 'user',
              text: 'The preview is ready.',
              questions: [{ text: 'Land it?', kind: 'confirm' }],
            }),
          ],
          { stopReason: 'toolUse' },
        )
      : fauxAssistantMessage('Noted.')
  }
  server.host.faux!.setResponses([route])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const { model, tools } = await server.root.agent(context)
  const branch = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model, tools } },
    context,
  )
  // @ultimate started it, which makes it a branch: one that asks the user in its own conversation.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, branch.id)).by = ultimate
  }, context)
  await (await branch.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = async () =>
    (await log())?.messages.find((m) => m.from === branch.id && m.to === 'user')
  await until(async () => !!(await ask()))
  const asked = (await ask())!

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const row = page.locator(`[data-waiting-on-you] [data-waiting-message="${asked.id}"]`)
  await row.getByRole('button', { name: /asks you 1 question · Land it\?/ }).click()
  await row.getByRole('button', { name: 'Yes' }).click()
  await row.getByRole('button', { name: /^Send/ }).click()
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toBe('Land it?: Yes')
  await row.waitFor({ state: 'detached' })
  expect(await page.locator('[data-waiting-on-you]').count()).toBe(0)
})
