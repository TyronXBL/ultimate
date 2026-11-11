// Main-thread cost of a streamed answer (#207122): shows each conversation, then feeds its shown subscription a
// synthetic run whose partial answer grows by one chunk every `--every` ms (Pi commits partials every 100 ms), as
// `pi.live` ops on the page's own event stream, and reads Chromium's main-thread metrics before and after, less the
// same time without chunks. Per chunk it prints task, script, style and layout time and the long animation frames.
// Usage: node stream.ts <url> <id,id,...> [--chunks 120] [--every 100] [--profile out.cpuprofile] [--trace]
// --profile and --trace record the first id only: a CPU profile with source positions as switch.ts records them, and a
// split of the main thread's time by trace event (paint, style, layout, GC).
import { writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { chromium } from 'playwright-core'
import { browserBinary } from '../../../extensions/browser/server.ts'
import { fetchAssets, sourceFrames } from '../../../lib/source-frames.ts'

const args = process.argv.slice(2)
const [base, list] = args
const flag = (name: string, fallback: number) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : Number(args[index + 1])
}
const chunks = flag('--chunks', 120)
const every = flag('--every', 100)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined

const browser = await chromium.launch({
  executablePath: await browserBinary(),
  chromiumSandbox: true,
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>
  sessionStorage.setItem('ultimate.driven', '1')
  const Native = window.EventSource
  window.EventSource = class extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      w.streamSource = this
    }
  }
  const subs: { url: string; conversation?: number; view: boolean }[] = []
  w.streamSubs = subs
  const nativeFetch = window.fetch
  window.fetch = (input, init) => {
    const body = init?.method === 'POST' && init.body
    if (typeof body === 'string' && typeof input === 'string' && input.startsWith('/api/events/'))
      subs.push({ url: input, ...(JSON.parse(body) as { conversation?: number; view: boolean }) })
    return nativeFetch(input, init)
  }
  const frames: number[] = []
  w.streamFrames = frames
  new PerformanceObserver((observed) => {
    for (const entry of observed.getEntries()) frames.push(entry.duration)
  }).observe({ type: 'long-animation-frame', buffered: false })
})
const cdp = await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
const metrics = async () => {
  const { metrics: all } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(all.map(({ name, value }) => [name, value]))
}
const bundle = async () =>
  page.evaluate(() => document.querySelector('meta[name="ultimate-web"]')?.getAttribute('content'))

const ids = list.split(',').map(Number)
await page.goto(`${base}/?conversation=${ids[0]}`)
await page.waitForFunction(() => 'ultimate' in window)
console.log(JSON.stringify({ identity: { url: base, bundle: await bundle(), loadavg: loadavg() } }))
for (const id of ids) {
  await page.evaluate((target) => {
    history.pushState(null, '', `/?conversation=${target}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, id)
  await page.waitForTimeout(5000)
  const rows = await page.evaluate(
    () => document.querySelectorAll('[data-ui="transcript"] [data-entry-id]').length,
  )
  const sub = await page.evaluate((target) => {
    const w = window as unknown as {
      streamSubs: { url: string; conversation?: number; view: boolean }[]
    }
    return Number(
      w.streamSubs
        .findLast((item) => item.conversation === target && item.view)
        ?.url.split('/')
        .at(-1),
    )
  }, id)
  // The same time without chunks: what the page does anyway (clocks, other events), to subtract.
  const quiet = await metrics()
  await page.waitForTimeout(chunks * every + 500)
  const idle = await metrics()
  const profiling = profile && id === ids[0]
  if (profiling) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
  }
  const tracing = args.includes('--trace') && id === ids[0]
  if (tracing)
    await browser.startTracing(page, {
      categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8'],
    })
  const before = await metrics()
  const shown = await page.evaluate(
    async (run) => {
      const w = window as unknown as { streamSource: EventSource; streamFrames: number[] }
      w.streamFrames.length = 0
      const send = (name: string, data: unknown) =>
        w.streamSource.dispatchEvent(
          new MessageEvent(name, { data: `${run.sub}\n${JSON.stringify(data)}` }),
        )
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        api: 'openai-responses',
        provider: 'synthetic',
        model: 'synthetic',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      // The shown conversation's documents ride in its view: `ops` on the view, as the server sends them.
      send('ops', [
        [
          's',
          ['docs', 'pi.live'],
          { run: { taskId: 1, inputs: [], turns: 0 }, generation: { attempt: 1, message } },
        ],
      ])
      const words =
        'the transcript mounts rows `code` and **bold** text while the answer streams in'.split(' ')
      for (let index = 0; index < run.chunks; index++) {
        await new Promise((resolve) => setTimeout(resolve, run.every))
        const text = `${words.slice(index % 5).join(' ')}${index % 8 === 7 ? '\n\n' : ' '}`
        send('ops', [
          ['a', ['docs', 'pi.live', 'generation', 'message', 'content', 0, 'text'], text],
        ])
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      const streamed =
        document.querySelector('[data-ui="transcript"]')?.textContent?.includes('streams in') ??
        false
      send('ops', [['s', ['docs', 'pi.live'], {}]])
      return streamed
    },
    { sub, chunks, every },
  )
  const after = await metrics()
  if (tracing) {
    const trace = JSON.parse((await browser.stopTracing()).toString()) as {
      traceEvents: {
        name: string
        ph: string
        dur?: number
        tid: number
        pid: number
        args?: { data?: { frame?: string } }
      }[]
    }
    // The renderer's main thread: the one running the page's script.
    const main = trace.traceEvents.find((event) => event.name === 'FunctionCall')
    const totals = new Map<string, number>()
    for (const event of trace.traceEvents)
      if (event.ph === 'X' && event.tid === main?.tid && event.pid === main.pid && event.dur)
        totals.set(event.name, (totals.get(event.name) ?? 0) + event.dur / 1000)
    console.log(
      JSON.stringify({
        traceMsPerChunk: Object.fromEntries(
          [...totals]
            .filter(([, ms]) => ms / chunks >= 0.3)
            .toSorted((a, b) => b[1] - a[1])
            .map(([name, ms]) => [name, Math.round((ms / chunks) * 10) / 10]),
        ),
      }),
    )
  }
  if (profiling) {
    const { profile: data } = await cdp.send('Profiler.stop')
    const positions = data.nodes.map(
      ({ callFrame }) =>
        `${callFrame.url}:${callFrame.lineNumber + 1}:${callFrame.columnNumber + 1}`,
    )
    const mapped = (await sourceFrames(positions.join('\n'), fetchAssets(base))).split('\n')
    const sources = Object.fromEntries(
      data.nodes.flatMap((node, index) =>
        mapped[index] === positions[index] ? [] : [[node.id, mapped[index]]],
      ),
    )
    const identity = { ultimateRoot: process.cwd(), url: base }
    writeFileSync(profile, JSON.stringify({ ...data, ultimate: { identity, sources } }))
  }
  const frames = await page.evaluate(
    () => (window as unknown as { streamFrames: number[] }).streamFrames,
  )
  const per = (key: string) =>
    Math.round(((after[key] - before[key] - (idle[key] - quiet[key])) * 1000 * 100) / chunks) / 100
  console.log(
    JSON.stringify({
      id,
      rows,
      sub,
      chunks,
      shown,
      idleTaskMsPerChunk:
        Math.round(((idle.TaskDuration - quiet.TaskDuration) * 1000 * 100) / chunks) / 100,
      taskMsPerChunk: per('TaskDuration'),
      scriptMsPerChunk: per('ScriptDuration'),
      layoutMsPerChunk: per('LayoutDuration'),
      styleMsPerChunk: per('RecalcStyleDuration'),
      longFrames: frames.length,
      longFrameMs: Math.round(frames.reduce((a, b) => a + b, 0)),
      loadavg: loadavg().map((load) => Math.round(load * 100) / 100),
    }),
  )
}
await browser.close()
