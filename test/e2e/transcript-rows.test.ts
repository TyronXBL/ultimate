// A switch draws a transcript's newest rows first and the earlier ones after it (#205147, #207122): a jump to a row not
// drawn yet still lands on it, and a reader at the bottom stays there while rows go in above and new turns arrive.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Browser, Page } from 'playwright-core'
import { afterAll, expect, it } from 'vitest'
import { launchBrowser } from '../../extensions/browser/server.ts'
import { Started } from '../../extensions/messages/addresses.ts'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

let server: Awaited<ReturnType<typeof fauxServer>>
let browser: Browser
let ultimate: ConversationId
let branch: Awaited<ReturnType<typeof server.harness.createConversation>>
let question: number

/**
 * One server, browser and branch for both tests, made by the first that runs: a branch that asked the user a question,
 * then took enough turns to put it far above a screen of rows.
 */
let seeding: Promise<void> | undefined
const seeded = () => (seeding ??= seed())
async function seed() {
  const home = await temp('ultimate-transcript-rows-')
  cleanup.push(() => removeTemp(home))
  server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
    web: true,
  })
  cleanup.push(() => server.close())
  // The branch asks the user one question on its first input and acknowledges every other one.
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
      : fauxAssistantMessage(`Noted: ${String((last as { content: unknown }).content)}.`)
  }
  server.host.faux!.setResponses([route])
  browser = await launchBrowser()
  cleanup.push(() => browser.close())
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  ultimate = data.result as ConversationId
  const { model, tools } = await server.root.agent(context)
  branch = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model, tools } },
    context,
  )
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Started, branch.id)).by = ultimate
  }, context)
  for (const content of ['ask', ...Array.from({ length: 30 }, (_, index) => `turn ${index + 1}`)])
    await (await branch.submit({ type: 'input', content }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = async () =>
    (await log())?.messages.find((m) => m.from === branch.id && m.to === 'user')
  await until(async () => !!(await ask()))
  question = (await ask())!.id
}

/** Show conversation `id` the way the sidebar does, in the same page. */
const show = (page: Page, id: number) =>
  page.evaluate((target) => {
    history.pushState(null, '', `/?conversation=${target}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, id)

it('jumps to an open question whose row is not drawn yet', async () => {
  await seeded()
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } })
  cleanup.push(() => page.close())
  // Fake timers and frames: once paused, no frame draws the earlier rows, so they stay undrawn until the jump.
  await page.clock.install()
  await page.goto(`${server.url}/?conversation=${branch.id}`)
  const log = page.getByRole('log')
  await log.getByText('Noted: turn 30.').waitFor()
  await show(page, ultimate)
  // Its own view in, before the pause: arriving later, it would take the place of the branch shown from its copy.
  await page
    .locator(`[data-ui="transcript"] [data-conversation-id="${ultimate}"]`)
    .first()
    .waitFor()
  // A second ahead, not more: a long jump fires the page's own timers, such as the stream's liveness checks.
  await page.clock.pauseAt(Date.now() + 1000)
  // Back to the branch from the tab's kept copy: its newest rows draw, the rest wait for a frame.
  await show(page, branch.id)
  await log.getByText('Noted: turn 30.').waitFor()
  const card = page.locator(`[data-message-outgoing="${question}"]`)
  expect(await card.count()).toBe(0)
  // All of it is loaded: the top marker stands only for rows not drawn yet.
  expect(await page.locator('[data-earlier-history]').count()).toBe(1)

  const mark = page.getByRole('button', { name: 'A question awaits your reply above' })
  await mark.click()
  // The mark asks for the jump in the next frame.
  await page.clock.runFor(20)
  await card.waitFor()
  const top = await card.evaluate((node) => node.getBoundingClientRect().top)
  const view = await log.evaluate((node) => node.getBoundingClientRect())
  expect(top).toBeGreaterThanOrEqual(view.top)
  expect(top).toBeLessThan(view.bottom)
  // With the card on screen, the mark that pointed up to it is gone.
  await mark.waitFor({ state: 'detached' })
})

it('stays at the bottom while earlier rows draw and new turns arrive', async () => {
  await seeded()
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } })
  cleanup.push(() => page.close())
  // The scroll-to-bottom button shows whenever the view lets go of the bottom.
  await page.addInitScript(() => {
    const w = window as unknown as { leftBottom: boolean }
    w.leftBottom = false
    new MutationObserver(() => {
      if (document.querySelector('[aria-label="Scroll to bottom"]')) w.leftBottom = true
    }).observe(document, { subtree: true, childList: true })
  })
  await page.goto(`${server.url}/?conversation=${branch.id}`)
  const log = page.getByRole('log')
  await log.getByText('Noted: turn 30.').waitFor()
  for (const content of ['turn 31', 'turn 32', 'turn 33'])
    await (await branch.submit({ type: 'input', content }, context)).wait(context)
  await log.getByText('Noted: turn 33.').waitFor()
  // Every row drawn: with all of the history loaded, the top marker stood only for rows not drawn yet.
  await page.locator('[data-earlier-history]').waitFor({ state: 'detached' })
  // The view follows the last rows in the frame after they went in.
  const distance = await page.evaluate(async () => {
    await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)))
    const scroll = document.querySelector('[data-ui="transcript"]')!.parentElement!
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
  })
  expect(distance).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => (window as unknown as { leftBottom: boolean }).leftBottom)).toBe(
    false,
  )
})
