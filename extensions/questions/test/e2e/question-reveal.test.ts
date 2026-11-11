// "answer" on a question in To-dos opens the asker's conversation with the question's card at the top of the view. It
// once left the view at the bottom: clearing the request re-ran the effect whose cleanup cancelled the reveal's frame.
// The card must also land below the pinned prompt strip, which arrives after the jump, not at the top of the response
// that asked, whose text comes first; a short question at the end needs room below it to get there. A link to a question,
// `?conversation=<c>&message=<m>`, once opened the conversation at its end, leaving the question to look for.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../../browser/server.ts'
import { Started } from '../../../messages/addresses.ts'
import { Messages } from '../../../messages/api.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const step = (n: number) =>
  `## Step ${n}\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12)}\n\n- one\n- two\n- three`

/** A branch asking two questions between long answers, another conversation, and a browser. */
async function setup() {
  const home = await temp('ultimate-question-reveal-')
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
  // The branch asks with its reasoning first, as models do; anything else gets a long answer.
  let steps = 0
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    if (last.role === 'user' && typeof last.content === 'string' && last.content.startsWith('ask'))
      return fauxAssistantMessage(
        [
          fauxText(`Here is my assessment. ${'It weighs both ways. '.repeat(20)}`),
          fauxToolCall('message', {
            to: 'user',
            text: `${last.content}: one decision before I go on.`,
            questions: [
              {
                text: 'Which way?',
                kind: 'choice',
                ref: '1',
                options: [
                  { label: 'this way', key: 'a', recommended: true },
                  { label: 'that way', key: 'b' },
                ],
              },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage(last.role === 'user' ? step(++steps) : 'Waiting on you.')
  }
  server.host.faux!.setResponses([route])
  const created = async () => (await post(server, '/api/conversations', {})).data.id as number
  const [branch, other] = [await created(), await created()]
  // Started by another conversation, the branch may ask the user.
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, branch as ConversationId)).by = other
  }, context)
  const say = async (id: number, content: string) =>
    (
      await (await server.harness.conversation(id as ConversationId, context))!.submit(
        { type: 'input', content },
        context,
      )
    ).wait(context)
  // One question sits between long answers, far above the bottom the conversation opens at; the other is the newest.
  for (const content of ['one', 'two', 'ask early', 'three', 'four', 'five', 'six', 'ask last'])
    await say(branch, content)
  await say(other, 'hello')
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const asked = (await log())!.messages.filter((message) => message.to === 'user')
  expect(asked).toHaveLength(2)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  return { server, branch, other, asked, browser }
}

/**
 * The card's top, the prompt strip's bottom and the lowest strip's bottom, once the card and the prompt strip show.
 * This fork's `transcript.top` also holds the pinned user turn (`extensions/pinned-turn`), which shows below the prompt
 * strip while the view reads up through an answer and hides at the end of the transcript.
 */
const measure = (page: Page, id: number) =>
  page.evaluate((message) => {
    const card = document.querySelector(`[data-message-outgoing="${message}"]`)
    const prompt = document.querySelector('[data-ui="pinned-prompt"]')
    const turn = document.querySelector('[data-pinned-turn]')
    if (!card || !prompt) return undefined
    const below = prompt.getBoundingClientRect().bottom
    return {
      card: card.getBoundingClientRect().top,
      prompt: below,
      lowest: Math.max(below, turn?.getBoundingClientRect().bottom ?? 0),
    }
  }, id)

/** The pinned turn's height on these viewports: the most the reveal may keep clear of above the card. */
const TURN = 52

/**
 * Whether the card sits at the top of the view: uncovered, with only the bubble's own top margin (8) below the strips.
 * The reveal keeps clear of the most the strips covered while it held, since following a strip that hides can loop; so
 * when the reveal reaches the end of the transcript, where the pinned turn hides, the card may stay up to one pinned
 * turn lower than the prompt strip alone needs.
 */
const placed = (at: { card: number; prompt: number; lowest: number }) =>
  at.card - at.lowest >= 4 && at.card - at.prompt - 8 <= TURN + 4

/**
 * Waits for a revealed card to be placed and still for half a second (the pinned turn grows in after the jump, and the
 * reveal follows it), then returns how far it moved since.
 */
async function drift(page: Page, id: number) {
  let settled = Number.NaN
  let since = 0
  await until(async () => {
    const now = await measure(page, id)
    if (!now || !placed(now)) {
      settled = Number.NaN
      return false
    }
    if (!(Math.abs(now.card - settled) <= 1)) {
      settled = now.card
      since = performance.now()
    }
    return performance.now() - since >= 500
  }, 10_000)
  const end = (await measure(page, id))!
  expect(placed(end)).toBe(true)
  return Math.abs(end.card - settled)
}

it('brings the question card to the top of the view below the pinned strip', async () => {
  const { server, other, asked, browser } = await setup()
  await post(server, '/api/ui', { set: { 'shell.panel': 'todos', 'shell.panelOpen': true } })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${other}`)
  // From another conversation, then within the branch.
  for (const { id } of asked) {
    await page.locator(`[data-todo-question="${id}"] button`).click()
    expect(await drift(page, id)).toBeLessThan(4)
  }
})

it('opens a question link at the question, once', async () => {
  const { server, branch, asked, browser } = await setup()
  const [{ id }] = asked
  // A phone, opened cold by the link: the page mounts the transcript after the overlay that reveals.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(`${server.url}/?conversation=${branch}&message=${id}`)
  expect(await drift(page, id)).toBeLessThan(4)
  // A reload opens the conversation as usual.
  expect(new URL(page.url()).search).toBe(`?conversation=${branch}`)
})
