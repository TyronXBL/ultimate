// Answers a three-question card in a real browser with only the keyboard: letter keys choose, ↑/↓ move between
// questions, Enter sends; the reply reaches @ultimate in the message's own numbering, with the note field's text after it.
// After Accept picks one Enter sends, and leaving the page right after it, in the same task, still sends the answer.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord/json'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Browser, Page } from 'playwright-core'
import { afterAll, afterEach, expect, it } from 'vitest'
import { launchBrowser } from '../../../browser/server.ts'
import { Messages } from '../../../messages/api.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../../../../test/helpers.ts'

const questions: JsonValue[] = [
  {
    text: 'Branch starts in the context',
    kind: 'choice',
    ref: '1',
    options: [
      { label: 'one-line intent plus breadcrumb', key: 'a', recommended: true },
      { label: 'drop them, rely on abstracts', key: 'b' },
      { label: 'leave as is', key: 'c' },
    ],
  },
  {
    text: "Boxer's copied agents/ultimate.md",
    kind: 'choice',
    ref: '2',
    options: [
      { label: 'assess a way to add tools without forking it', key: 'a', recommended: true },
      { label: 'leave it', key: 'b' },
    ],
  },
  {
    text: 'Land it',
    kind: 'choice',
    ref: '3',
    options: [
      { label: 'yes', key: 'a', recommended: true },
      { label: 'no, change something first', key: 'b' },
    ],
  },
]

const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
// Each test's page goes with the test: the held-answer test throttles its page's CPU, which Chromium does by keeping
// that renderer's main thread busy, so left open it took most of a core from the next test's page load.
const pages: Page[] = []
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close()
})

let server: Awaited<ReturnType<typeof fauxServer>>
let browser: Browser
let ultimate: ConversationId

/**
 * One server and browser for both tests, made by the first that runs. A server and a browser of its own for each test
 * was most of this file's work, and the letters test timed out at 60 s on a busy CI runner four times (#220179, then
 * `64d0b17`): under load its fixture alone took 40 s of the 52 s it ran.
 */
let seeding: Promise<void> | undefined
const seeded = () => (seeding ??= seed())
async function seed() {
  const home = await temp('ultimate-questions-keys-')
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
  // @ultimate asks the user the three decisions on each `ask`, and acknowledges anything else.
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    return last.role === 'user' && last.content === 'ask'
      ? fauxAssistantMessage(
          [fauxToolCall('message', { to: 'user', text: 'The preview is ready.', questions })],
          {
            stopReason: 'toolUse',
          },
        )
      : fauxAssistantMessage('Noted.')
  }
  server.host.faux!.setResponses([route])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  ultimate = data.result as ConversationId
  browser = await launchBrowser()
  cleanup.push(() => browser.close())
}

/** @ultimate asks again, and a page of its own shows the new card. */
async function openCard() {
  await seeded()
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = async () => (await log())?.messages.findLast((m) => m.to === 'user' && m.reply)
  const before = (await ask())?.id
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  await until(async () => (await ask())?.id !== before)
  const asked = (await ask())!

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  pages.push(page)
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const card = page.locator(`[data-questions-card="message:${asked.id}"]`)
  await card.locator('fieldset').nth(2).waitFor()
  return { log, asked, page, card }
}

// Accept picks, then a single Enter sends: before ee569d52 it only moved to the next question. Proven here, not on a
// second card in the test below, which made that test twice as long as other browser tests and ran it past 60 s on CI
// runners (#220179). First in the file: the first test pays for the server and the browser, and this is the short one.
it('sends a held answer when the page is left inside the undo window', async () => {
  const { log, asked, page, card } = await openCard()
  await card.getByRole('button', { name: 'Accept picks' }).click()
  // Enter sends and the page goes away in one task, on a slow device, before the card renders Undo. The card listened
  // for beforeunload only once Undo showed, so this send fell to its pagehide listener, which ran after the page's
  // other pagehide work: 6 of 20 were lost at this throttling (#222078).
  const devtools = await page.context().newCDPSession(page)
  await devtools.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  await page.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    location.href = 'about:blank'
  })
  await page.waitForURL('about:blank')
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toMatch(/^1a\. .+\n\n2a\. .+\n\n3a\. Land it: yes$/)
})

it('answers a decisions card with letters, arrows and Enter', async () => {
  const { log, asked, page, card } = await openCard()
  // The composer takes focus on desktop and keeps its keys; the card takes them once the user leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // Question 1: b; down to 2: a; down to 3: b; back up twice and change 1 to c.
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('a')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('c')
  expect(await card.locator('[aria-pressed=true]').allTextContents()).toEqual([
    expect.stringContaining('leave as is'),
    expect.stringContaining('assess a way to add tools'),
    expect.stringContaining('no, change something first'),
  ])
  // `/` opens the note field without choosing anything; Enter there sends, past the undo window.
  await page.keyboard.press('/')
  await page.keyboard.insertText('Also rename the tab.')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.insertText('And soon.')
  // The undo window stays open until this test's Enter: with the page's timers paused it cannot run out by itself
  // first, however late a busy runner gets here. A second ahead, not more, as in transcript-rows.test.ts.
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 1000)
  await page.keyboard.press('Enter')
  // The undo bar fills by itself, from empty to full: a quarter into its animation it is a quarter as wide as its track.
  // Set on the animation, not waited for: the bar's width after a 500 ms wait was anything on a busy runner.
  const bar = card.locator('[data-countdown]')
  const filled = await bar.evaluate((node) => {
    const [filling] = node.getAnimations()
    filling.pause()
    filling.currentTime = Number(filling.effect!.getComputedTiming().duration) / 4
    return node.getBoundingClientRect().width / node.parentElement!.getBoundingClientRect().width
  })
  expect(filled).toBeCloseTo(0.25, 1)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Enter')
  await page.clock.resume()
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toBe(
    "1c. Branch starts in the context: leave as is\n\n2a. Boxer's copied agents/ultimate.md: assess a way to add tools without forking it\n\n3b. Land it: no, change something first\n\nNote: Also rename the tab.\nAnd soon.",
  )
  await card.waitFor({ state: 'detached' })
})
