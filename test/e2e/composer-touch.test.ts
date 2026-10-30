// A touch keyboard has no Alt+Enter: while a run is busy, a draft offers Queue and Steer, and Stop shows only for an
// empty draft, so a slip next to Send never ends the run.
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { browserBinary } from '../../extensions/browser/server.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, held, post, removeTemp, temp, until } from '../helpers.ts'
import { InboxDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('queues and steers from a touch composer while a run is busy', async () => {
  const home = await temp('ultimate-composer-touch-')
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
  server.host.faux!.setResponses([held])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await conversation.submit({ type: 'input', content: 'work' }, context)

  const browser = await chromium.launch({
    executablePath: await browserBinary(),
    headless: true,
    // Keep the profile in the test's TMPDIR, but let Chromium put its singleton socket in the short system temp path.
    env: { ...process.env, TMPDIR: undefined },
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 390, height: 797 },
    hasTouch: true,
    isMobile: true,
  })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const composer = page.locator('[data-composer-target="conversation"]')
  const button = (name: string) => composer.getByRole('button', { name, exact: true })
  await button('Stop').waitFor()
  const draft = async (text: string, shows: string) => {
    await composer.locator('#composer-input').fill(text)
    await button(shows).waitFor()
  }

  await draft('Queued note', 'Queue')
  expect(await button('Stop').count()).toBe(0)
  const modes = async () =>
    ((await server.harness.snapshot(InboxDoc, ultimate, context))?.items ?? []).map((item) =>
      item.mode === 'write' ? [item.mode] : [item.mode, item.content],
    )
  await button('Queue').tap()
  await until(async () => (await modes()).length === 1)

  await draft('Steering note', 'Steer')
  await button('Steer').tap()
  await until(async () => (await modes()).length === 2)
  await button('Stop').waitFor()
  expect(await modes()).toEqual([
    ['followUp', 'Queued note'],
    ['steer', 'Steering note'],
  ])
})
