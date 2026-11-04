// On a phone the right panel's tabs scroll the shown one into view. Chromium's scrollIntoView returns a promise, and an
// effect that returned it crashed the Agent surface as soon as the panel opened or switched tabs. The panel opens while
// the page still lands on @ultimate, and that redirect once closed it again.
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { launchBrowser } from '../../extensions/browser/server.ts'
import { fauxServer, removeTemp, temp } from '../helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('opens the right panel and switches its tabs on a phone', async () => {
  const home = await temp('ultimate-phone-panel-')
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

  const browser = await launchBrowser()
  cleanup.push(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 390, height: 797 },
    hasTouch: true,
    isMobile: true,
  })
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(server.url)
  await page.locator('#app').getByRole('button', { name: 'Toggle panel' }).tap()
  const tabs = page.locator('[data-ui="phone-panel-tabs"] button')
  await tabs.and(page.locator('[aria-current]')).waitFor()
  const other = tabs.and(page.locator(':not([aria-current])')).first()
  const name = (await other.textContent()) ?? ''
  await other.tap()
  await tabs.and(page.locator('[aria-current]')).filter({ hasText: name }).waitFor()
  expect(errors.filter((error) => error.includes('destroy is not a function'))).toEqual([])
})
