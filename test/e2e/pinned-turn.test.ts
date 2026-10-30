// Scrolls up through a long answer in a real browser: a line at the top names the user turn it answers, cut to its
// first phrase, and a click on it scrolls back to that turn.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const answer = (topic: string) =>
  Array.from({ length: 40 }, (_, index) => `${topic} paragraph ${index + 1}.`).join('\n\n')

it('pins the answered user turn while scrolled up and reveals it on click', async () => {
  const home = await temp('ultimate-pinned-turn-')
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
  server.host.faux!.setResponses([
    fauxAssistantMessage(answer('Alpha')),
    fauxAssistantMessage(answer('Beta')),
  ])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  for (const content of [
    'Explain alpha first.\nThen everything else about it.',
    'Now explain beta in detail. And the rest of it.',
  ])
    await (await conversation.submit({ type: 'input', content }, context)).wait(context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const log = page.getByRole('log')
  await log.getByText('Beta paragraph 40.').waitFor()
  const pinned = page.locator('[data-pinned-turn]')
  expect(await pinned.count()).toBe(0)

  // Scroll so the middle of the beta answer is at the top: the line names the beta turn.
  await log.getByText('Beta paragraph 20.', { exact: true }).evaluate((node) => {
    node.scrollIntoView({ block: 'start' })
  })
  await pinned.waitFor()
  expect(await pinned.textContent()).toBe('Now explain beta in detail…')
  // Visible, not covered: the element at its centre is the line itself.
  const button = pinned.getByRole('button')
  expect(
    await button.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }),
  ).toBe(true)

  // Further up, inside the alpha answer, it follows.
  await log.getByText('Alpha paragraph 20.', { exact: true }).evaluate((node) => {
    node.scrollIntoView({ block: 'start' })
  })
  await page.waitForFunction(
    () => document.querySelector('[data-pinned-turn]')?.textContent === 'Explain alpha first…',
  )

  // A click scrolls back to the alpha turn, which then hides the line.
  await button.click()
  const turn = log.getByText('Then everything else about it.', { exact: false })
  await page.waitForFunction(() => !document.querySelector('[data-pinned-turn]'))
  expect(await turn.isVisible()).toBe(true)
  const top = await turn.evaluate((node) => node.getBoundingClientRect().top)
  const view = await log.evaluate((node) => node.getBoundingClientRect())
  expect(top).toBeGreaterThanOrEqual(view.top)
  expect(top).toBeLessThan(view.bottom)
})
