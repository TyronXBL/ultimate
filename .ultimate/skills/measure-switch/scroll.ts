// What a reader's first scroll feels like right after a switch (#207122): switches to each conversation (once cold to
// warm them up, then measured warm), and scrolls up with the wheel at once, every 50 ms for 1.5 s. Reports the main
// thread's frames in those 2 s: the longest gap between frames, gaps over 50 ms, the time lost to frames longer than
// one (16.7 ms each), long animation frames, and how far the view moved.
// Usage: node scroll.ts <url> <id,id,...> [--rounds 2]
import { loadavg } from 'node:os'
import { chromium } from 'playwright-core'
import { browserBinary } from '../../../extensions/browser/server.ts'

const args = process.argv.slice(2)
const [base, list] = args
const rounds = args.includes('--rounds') ? Number(args[args.indexOf('--rounds') + 1]) : 2
const browser = await chromium.launch({
  executablePath: await browserBinary(),
  chromiumSandbox: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => {
  sessionStorage.setItem('ultimate.driven', '1')
  const w = window as unknown as { scrollFrames: number[]; scrollLong: number[] }
  w.scrollFrames = []
  w.scrollLong = []
  const tick = (time: number) => {
    w.scrollFrames.push(time)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  new PerformanceObserver((observed) => {
    for (const entry of observed.getEntries()) w.scrollLong.push(entry.duration)
  }).observe({ type: 'long-animation-frame' })
})
const ids = list.split(',').map(Number)
await page.goto(`${base}/?conversation=${ids.at(-1)}`)
await page.waitForFunction(() => 'ultimate' in window)
await page.waitForTimeout(4000)
await page.mouse.move(700, 450)
console.log(JSON.stringify({ identity: { url: base, loadavg: loadavg() } }))
for (let round = 0; round < rounds; round++)
  for (const id of ids) {
    await page.evaluate((target) => {
      const w = window as unknown as { scrollFrames: number[]; scrollLong: number[] }
      w.scrollFrames.length = 0
      w.scrollLong.length = 0
      history.pushState(null, '', `/?conversation=${target}`)
      dispatchEvent(new PopStateEvent('popstate'))
    }, id)
    const start = Date.now()
    while (Date.now() - start < 1500) {
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(500)
    // How far above the bottom the reader got: 30 wheel steps of 120 px is 3600 px.
    const moved = await page.evaluate(() => {
      const scroll = document.querySelector('[data-ui="transcript"]')?.parentElement
      return scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : -1
    })
    const result = await page.evaluate(() => {
      const w = window as unknown as { scrollFrames: number[]; scrollLong: number[] }
      const gaps = w.scrollFrames.slice(1).map((time, index) => time - w.scrollFrames[index])
      return {
        frames: gaps.length,
        maxGapMs: Math.round(Math.max(0, ...gaps)),
        over50: gaps.filter((gap) => gap > 50).length,
        lostMs: Math.round(gaps.reduce((sum, gap) => sum + Math.max(0, gap - 16.7), 0)),
        longFrames: w.scrollLong.length,
        longFrameMs: Math.round(w.scrollLong.reduce((a, b) => a + b, 0)),
      }
    })
    console.log(JSON.stringify({ round, id, ...result, movedPx: Math.round(moved) }))
  }
await browser.close()
