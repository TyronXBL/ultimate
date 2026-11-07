// Measure conversation switches in a real Chromium against a running Ultimate (a preview on a paused copy).
// Usage: node switch.ts <url> <start id> <id,id,...> [--rounds 2] [--profile out.cpuprofile]
// Round 0 switches are cold (never shown in this tab), later rounds warm. Per switch it prints one JSON line: time to
// the stream's `view` event, `settled` (the last DOM change before 300 ms of quiet), main-thread long tasks, server
// event bytes, streams opened and JS heap; then medians per round. The first line is the identity of what was measured.
// --profile writes a CDP CPU profile of every switch, with that identity and each function's source position as its
// bundle's source map names it (`ultimate.sources`, by node id), resolved now: a rebuild deletes the bundle soon after.
import { writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { chromium } from 'playwright-core'
import type { SystemInfo } from '../../../shared/protocol.ts'
import { browserBinary } from '../../../extensions/browser/server.ts'
import { git } from '../../../lib/git.ts'
import { fetchAssets, sourceFrames } from '../../../lib/source-frames.ts'

const args = process.argv.slice(2)
const [base, start, list] = args
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
if (!base || !start || !list) throw new Error('Usage: node switch.ts <url> <start id> <id,id,...>')
const rounds = Number(flag('--rounds') ?? 2)
const profile = flag('--profile')

const browser = await chromium.launch({
  executablePath: await browserBinary(),
  chromiumSandbox: true,
  args: ['--enable-precise-memory-info'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>
  // `window.ultimate` (web/src/sdk/test-hook.ts) for the readiness wait.
  sessionStorage.setItem('ultimate.driven', '1')
  const log: { t: number; ev: string; url: string; kb?: number; conversation?: number }[] = []
  w.switchEvents = log
  const Native = window.EventSource
  const systems: string[] = []
  w.switchSystems = systems
  window.EventSource = class extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      const href = String(url)
      log.push({ t: performance.now(), ev: 'open', url: href })
      for (const name of ['stream', 'view', 'conversations', 'system', 'tasks', 'ui', 'doc'])
        this.addEventListener(name, (event) => {
          const data = (event as MessageEvent<string>).data
          if (name === 'system') systems.push(data)
          // A subscription's view is `<sub>\n{"conversation":{"id":N},…}`: read its id without parsing the rest.
          const id = /^\d+\n\{"conversation":\{"id":(\d+)/.exec(data.slice(0, 80))?.[1]
          log.push({
            t: performance.now(),
            ev: name,
            url: href,
            kb: data.length / 1024,
            ...(id && { conversation: Number(id) }),
          })
        })
    }
  }
  const long: { t: number; d: number }[] = []
  w.switchLongTasks = long
  new PerformanceObserver((observed) => {
    for (const entry of observed.getEntries()) long.push({ t: entry.startTime, d: entry.duration })
  }).observe({ type: 'longtask', buffered: true })
  new MutationObserver(() => {
    w.switchLastMutation = performance.now()
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
})
await page.goto(`${base}/?conversation=${start}`)
await page.waitForFunction(() => 'ultimate' in window)
await page.evaluate(() =>
  (window as unknown as { ultimate: { state(): Promise<unknown> } }).ultimate.state(),
)
await page.waitForTimeout(4000)

// What was measured: the checkout's commit and uncommitted files, the server build and the web bundle the page runs.
// Commits alone do not say what a comparison changed when main moved (an upstream merge) between the two runs.
const system = JSON.parse(
  (await page.evaluate(() =>
    (window as unknown as { switchSystems: string[] }).switchSystems.at(-1),
  ))!,
) as SystemInfo
const bundle = await page.locator('meta[name="ultimate-web"]').getAttribute('content')
if (system.web.building || bundle !== system.web.id)
  throw new Error(
    `The page runs bundle ${bundle}, the server serves ${system.web.id}${system.web.building ? ' and is building' : ''}: wait for the switch and run again`,
  )
const root = system.code.ultimateRoot
const identity = {
  url: base,
  at: new Date().toISOString(),
  ultimateRoot: root,
  branch: system.code.branch,
  sha: await git(root, 'rev-parse', 'HEAD'),
  uncommitted: (await git(root, 'status', '--porcelain'))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().replace(/^\S+\s+/, '')),
  serverBuild: system.build.id,
  webBundle: bundle,
  browser: browser.version(),
  cpus: `${cpus().length} × ${cpus()[0]?.model}`,
  loadavg: loadavg().map((load) => Math.round(load * 100) / 100),
}
console.log(JSON.stringify({ identity }))

const cdp = await page.context().newCDPSession(page)
if (profile) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
}

type Result = Record<string, number>
const results: Result[] = []
for (let round = 0; round < rounds; round++)
  for (const target of list.split(',').map(Number)) {
    const result = await page.evaluate(async (id) => {
      const w = window as unknown as {
        switchEvents: { t: number; ev: string; url: string; kb?: number; conversation?: number }[]
        switchLongTasks: { t: number; d: number }[]
        switchLastMutation?: number
      }
      w.switchEvents.length = 0
      const started = performance.now()
      history.pushState(null, '', `/?conversation=${id}`)
      dispatchEvent(new PopStateEvent('popstate'))
      const pause = () => new Promise((resolve) => setTimeout(resolve, 10))
      const deadline = started + 20_000
      const ownView = () =>
        w.switchEvents.find((item) => item.ev === 'view' && item.conversation === id)
      while (!ownView() && performance.now() < deadline) await pause()
      while (performance.now() < deadline && performance.now() - (w.switchLastMutation ?? 0) < 300)
        await pause()
      const long = w.switchLongTasks.filter((item) => item.t >= started)
      const memory = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory
      return {
        id,
        viewMs: Math.round((ownView()?.t ?? deadline) - started),
        settledMs: Math.round((w.switchLastMutation ?? started) - started),
        longMs: Math.round(long.reduce((sum, item) => sum + item.d, 0)),
        maxLongMs: Math.round(Math.max(0, ...long.map((item) => item.d))),
        eventKb: Math.round(w.switchEvents.reduce((sum, item) => sum + (item.kb ?? 0), 0)),
        // A tab keeps one stream; a switch that opens one (a reconnect) shows up here.
        streams: w.switchEvents.filter((item) => item.ev === 'stream').length,
        heapMb: Math.round(memory.usedJSHeapSize / 1048576),
      }
    }, target)
    results.push({ round, ...result })
    console.log(JSON.stringify({ round, ...result }))
  }
if (profile) {
  const { profile: data } = await cdp.send('Profiler.stop')
  // Each function's start as a stack frame (1-based), resolved by the helper that maps error stacks; one it leaves as it
  // was has no mapping (no map, or code outside the bundle) and stays unattributed.
  const frames = data.nodes.map(
    ({ callFrame }) => `${callFrame.url}:${callFrame.lineNumber + 1}:${callFrame.columnNumber + 1}`,
  )
  const mapped = (await sourceFrames(frames.join('\n'), fetchAssets(base))).split('\n')
  const sources = Object.fromEntries(
    data.nodes.flatMap((node, index) =>
      mapped[index] === frames[index] ? [] : [[node.id, mapped[index]]],
    ),
  )
  writeFileSync(profile, JSON.stringify({ ...data, ultimate: { identity, sources } }))
}
await browser.close()

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
for (let round = 0; round < rounds; round++) {
  const rows = results.filter((row) => row.round === round)
  const keys = ['viewMs', 'settledMs', 'longMs', 'maxLongMs', 'eventKb', 'streams', 'heapMb']
  console.log(
    `${round === 0 ? 'cold' : `warm ${round}`} medians:`,
    Object.fromEntries(keys.map((key) => [key, median(rows.map((row) => row[key]))])),
  )
}
