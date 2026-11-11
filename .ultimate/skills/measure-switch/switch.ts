// Measure conversation switches in a real Chromium against a running Ultimate (a preview on a paused copy).
// Usage: node switch.ts <url> <start id> <id,id,...> [--rounds 2] [--profile out.cpuprofile]
// Round 0 switches are cold (never shown in this tab), later rounds warm. Per switch it prints one JSON line: time to
// the conversation's rows painted (`paintMs`), to the stream's `view` event and the four waits that make it up,
// `settled` (the last DOM change before 300 ms of quiet), main-thread long tasks, server event bytes, streams opened and
// JS heap; then medians per round. The first line is the identity of what was measured.
// --profile writes a CDP CPU profile of every switch, with that identity and each function's source position as its
// bundle's source map names it (`ultimate.sources`, by node id), resolved now: a rebuild deletes the bundle soon after.
import { writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
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
  const log: {
    t: number
    ev: string
    url: string
    kb?: number
    sub?: number
    conversation?: number
  }[] = []
  w.switchEvents = log
  const Native = window.EventSource
  // The latest system event, and every bundle state it announced, to tell a run that spanned a rebuild.
  const webs: unknown[] = []
  w.switchWebs = webs
  window.EventSource = class extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      const href = String(url)
      log.push({ t: performance.now(), ev: 'open', url: href })
      for (const name of ['stream', 'view', 'conversations', 'system', 'tasks', 'ui', 'doc'])
        this.addEventListener(name, (event) => {
          const data = (event as MessageEvent<string>).data
          if (name === 'system') {
            w.switchSystem = data
            webs.push(JSON.parse(data).web)
          }
          // A subscription's view is `<sub>\n{"conversation":{"id":N},…}`: read both ids without parsing the rest.
          const view = /^(\d+)\n\{"conversation":\{"id":(\d+)/.exec(data.slice(0, 80))
          log.push({
            t: performance.now(),
            ev: name,
            url: href,
            kb: data.length / 1024,
            ...(view && { sub: Number(view[1]), conversation: Number(view[2]) }),
          })
        })
    }
  }
  // Every subscription the page asks for (`POST /api/events/<stream>/<sub>`): when, and for which conversation.
  const subs: { t: number; url: string; conversation?: number; view: boolean }[] = []
  w.switchSubs = subs
  const subscription = /^\/api\/events\/[^/]+\/\d+$/
  const nativeFetch = window.fetch
  window.fetch = (input, init) => {
    const body = init?.method === 'POST' && init.body
    if (typeof body === 'string' && typeof input === 'string' && subscription.test(input))
      subs.push({
        t: performance.now(),
        url: input,
        ...(JSON.parse(body) as { conversation?: number; view: boolean }),
      })
    return nativeFetch(input, init)
  }
  const long: { t: number; d: number }[] = []
  w.switchLongTasks = long
  new PerformanceObserver((observed) => {
    for (const entry of observed.getEntries()) long.push({ t: entry.startTime, d: entry.duration })
  }).observe({ type: 'longtask', buffered: true })
  // `switchPaint.from` is the transcript element a switch leaves (each conversation gets its own): the first frame
  // painted with rows in another one is the switched-to conversation on screen.
  const paint: { from?: Element | null; seen?: boolean; t?: number } = {}
  w.switchPaint = paint
  new MutationObserver(() => {
    w.switchLastMutation = performance.now()
    if (paint.seen || !('from' in paint)) return
    const transcript = document.querySelector('[data-ui="transcript"]')
    if (!transcript || transcript === paint.from || !transcript.querySelector('[data-entry-id]'))
      return
    paint.seen = true
    // A task queued from an animation frame runs after that frame is painted.
    requestAnimationFrame(() => setTimeout(() => (paint.t = performance.now())))
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
let reloaded = false
page.on('load', () => (reloaded = true))
// Read in one evaluation, between event handlers: the latest system event and how many bundle states it ends.
const read = await page.evaluate(() => {
  const w = window as unknown as { switchSystem: string; switchWebs: unknown[] }
  return {
    system: w.switchSystem,
    announced: w.switchWebs.length,
    bundle: document.querySelector('meta[name="ultimate-web"]')?.getAttribute('content'),
  }
})
const system = JSON.parse(read.system) as SystemInfo
const { announced, bundle } = read
// A failed build keeps serving the previous bundle, and a broken facet is left out of it: neither is the checkout's code.
const webStates = () =>
  page.evaluate(() => (window as unknown as { switchWebs: SystemInfo['web'][] }).switchWebs)
const servedAsBuilt = (web: SystemInfo['web']) => {
  if (web.id !== bundle) throw new Error(`The page runs bundle ${bundle}, the server ${web.id}`)
  if (web.building) throw new Error('The bundle is building: wait for the switch and run again')
  if (web.error) throw new Error(`The bundle did not build: ${web.error}`)
  if (web.left?.length)
    throw new Error(`The bundle left out ${web.left.map((item) => item.file).join(', ')}`)
}
servedAsBuilt(system.web)
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
  cpus: `${system.machine.cpuCount} × ${system.machine.cpuModel}`,
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
        switchEvents: { t: number; ev: string; sub?: number; conversation?: number; kb?: number }[]
        switchSubs: { t: number; url: string; conversation?: number; view: boolean }[]
        switchPaint: { from?: Element | null; seen?: boolean; t?: number }
        switchLongTasks: { t: number; d: number }[]
        switchLastMutation?: number
      }
      w.switchEvents.length = 0
      w.switchSubs.length = 0
      performance.clearResourceTimings()
      w.switchPaint = Object.assign(w.switchPaint, {
        from: document.querySelector('[data-ui="transcript"]'),
        seen: false,
        t: undefined,
      })
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
      while (performance.now() < deadline && w.switchPaint.t === undefined) await pause()
      const long = w.switchLongTasks.filter((item) => item.t >= started)
      const memory = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory
      // Where the view's wait went: the subscription that brought it, by its request's timing. The server writes the
      // view to the stream before it answers the request, so the request's first byte is the server done.
      const view = ownView()
      const asked = w.switchSubs.find((item) => item.url.endsWith(`/${view?.sub}`))
      // The request's own answer follows the view; its timing is there once it has ended. The first entry of its URL:
      // closing the subscription later is a DELETE of the same one.
      const answered = () =>
        performance.getEntriesByName(new URL(asked?.url ?? '', location.href).href)[0] as
          | PerformanceResourceTiming
          | undefined
      if (asked) while (!answered() && performance.now() < deadline) await pause()
      const request = asked && answered()
      const ms = (value: number | undefined) => (value === undefined ? -1 : Math.round(value))
      return {
        id,
        // The conversation's rows painted: at once from the tab's kept replica on a warm switch, after `view` on a cold one.
        paintMs: ms(w.switchPaint.t === undefined ? undefined : w.switchPaint.t - started),
        viewMs: Math.round((view?.t ?? deadline) - started),
        // `viewMs` in four parts: until the page asks, until the request leaves (a free connection), until the server
        // has sent the view, until the page handles its event.
        askMs: ms(asked && asked.t - started),
        queueMs: ms(request && asked && request.requestStart - asked.t),
        serverMs: ms(request && request.responseStart - request.requestStart),
        handleMs: ms(request && view && view.t - request.responseStart),
        // How often the page asked for this conversation's view: each time the server reads and sends it whole.
        subs: w.switchSubs.filter((item) => item.conversation === id && item.view).length,
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
// A rebuild during the run (a save, a checkout switch) loads the machine and may swap the bundle: discard the run.
if (reloaded) throw new Error('The page reloaded during the run')
;(await webStates()).slice(announced).forEach(servedAsBuilt)
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
  const keys = ['paintMs', 'viewMs', 'askMs', 'queueMs', 'serverMs', 'handleMs', 'subs'].concat([
    'settledMs',
    'longMs',
    'maxLongMs',
    'eventKb',
    'streams',
    'heapMb',
  ])
  console.log(
    `${round === 0 ? 'cold' : `warm ${round}`} medians:`,
    Object.fromEntries(keys.map((key) => [key, median(rows.map((row) => row[key]))])),
  )
}
