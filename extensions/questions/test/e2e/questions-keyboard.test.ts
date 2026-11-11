// Answers a three-question card in a real browser with only the keyboard: letter keys choose, ↑/↓ move between
// questions, Enter sends; the reply reaches @ultimate in the message's own numbering, with the note field's text after it.
// After Accept picks one Enter sends, and leaving the page right after it, in the same task, still sends the answer.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { JsonValue } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
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
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

async function openCard() {
  const home = await temp('ultimate-questions-keys-')
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
  // @ultimate asks the user the three decisions on each input, and acknowledges anything else.
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
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = async () => (await log())?.messages.findLast((m) => m.to === 'user' && m.reply)
  await until(async () => !!(await ask()))
  const asked = (await ask())!

  const browser = await launchBrowser()
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const card = page.locator(`[data-questions-card="message:${asked.id}"]`)
  await card.locator('fieldset').nth(2).waitFor()
  return { log, asked, page, card }
}

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
  await page.keyboard.type('Also rename the tab.')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('And soon.')
  await page.keyboard.press('Enter')
  // The undo bar fills over the undo window by itself, without relying on a @starting-style transition.
  const bar = card.locator('[data-countdown]')
  await page.waitForTimeout(500)
  const width = await bar.evaluate((node) => node.getBoundingClientRect().width)
  const full = await bar.evaluate((node) => node.parentElement!.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(0)
  expect(width).toBeLessThan(full * 0.8)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Enter')
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toBe(
    "1c. Branch starts in the context: leave as is\n\n2a. Boxer's copied agents/ultimate.md: assess a way to add tools without forking it\n\n3b. Land it: no, change something first\n\nNote: Also rename the tab.\nAnd soon.",
  )
  await card.waitFor({ state: 'detached' })
})

// Accept picks, then a single Enter sends: before ee569d52 it only moved to the next question. Proven here, not on a
// second card in the test above, which made that test twice as long as other browser tests and ran it past 60 s on CI
// runners (#220179).
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
