import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { context } from '../../server/harness.ts'
import browserExtension from '../../extensions/browser/server.ts'
import { chromiumStatus, MINIMUM_CHROMIUM } from '../../extensions/browser/chromium-version.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { groupAlive } from '../../lib/process-group.ts'
import { removeTemp, temp, until } from '../helpers.ts'

// A managed Mac's Chrome dropped its CDP pipe seconds after each first page and kept running; every call launched
// another one, each failed context close raised a notice, and the dropped browsers piled up until the host exited.
it('kills a browser that drops its connection and keeps running, without a notice', async () => {
  const directory = await temp('ultimate-browser-dropped-')
  const pidFile = join(directory, 'chrome.pid')
  vi.stubEnv('ULTIMATE_CHROMIUM', resolve('test/e2e/dropping-chrome.ts'))
  vi.stubEnv('DROPPING_CHROME_PID', pidFile)
  const closers: (() => Promise<void>)[] = []
  const notices: string[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: directory,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    notice: (message: string) => notices.push(message),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
    implement() {},
  } as unknown as ExtensionHost
  const screenshot = browserExtension(host).tools!.find((tool) => tool.name === 'screenshot')!
  const api = { output() {} } as unknown as ToolExecutionApi
  let pid: number | undefined
  try {
    const result = await screenshot.execute({ url: 'data:text/html,x' }, api, context)
    expect(result.isError).toBe(true)
    pid = Number(await readFile(pidFile, 'utf8'))
    await until(() => !groupAlive(pid))
    expect(notices).toEqual([])
  } finally {
    if (pid && groupAlive(pid)) process.kill(-pid, 'SIGKILL')
    vi.unstubAllEnvs()
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})

it('times out a hung step, closes its page and keeps later calls working', async () => {
  const directory = await temp('ultimate-browser-timeout-')
  const closers: (() => Promise<void>)[] = []
  const notices: string[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: directory,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    notice: (message: string) => notices.push(message),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
    implement() {},
  } as unknown as ExtensionHost
  const browser = browserExtension(host).tools!.find((tool) => tool.name === 'browser')!
  const api = { output() {} } as unknown as ToolExecutionApi
  const url = 'data:text/html,<title>Hang</title>'
  const drive = async (steps: unknown[], timeoutMs?: number) => {
    const started = Date.now()
    const result = await browser.execute({ url, steps, screenshot: false, timeoutMs }, api, context)
    return { result, text: JSON.stringify(result.output), ms: Date.now() - started }
  }
  try {
    // The step limit also bounds the browser's launch: on a fresh CI runner the first call ran past 5 s before step 1,
    // so launch the shared browser first with the default limit. 5 s per step leaves a busy 4-CPU shard room to load
    // the page and still ends the hung step well inside the 15 s bound.
    expect((await drive([{ eval: 'document.title' }])).result.isError).toBeFalsy()
    for (const hang of ['new Promise(() => {})', 'for (;;) {}']) {
      const hung = await drive([{ eval: '1 + 1' }, { eval: hang }], 5000)
      expect(hung.result.isError).toBe(true)
      expect(hung.text).toContain('Step 1: OK 2')
      expect(hung.text).toContain('Step 2: TimeoutError: eval timed out after 5s')
      expect(hung.ms).toBeLessThan(15_000)
      const next = await drive([{ eval: 'document.title' }])
      expect(next.result.isError).toBeFalsy()
      expect(next.text).toContain('Step 1: OK \\"Hang\\"')
    }
    // A selector that matches nothing reports Playwright's own error, naming what it waited for, once.
    const missing = await drive([{ click: 'text=Nowhere' }], 2000)
    expect(missing.result.isError).toBe(true)
    expect(missing.text).toContain('Step 1: TimeoutError: locator.click: Timeout 2000ms exceeded.')
    expect(missing.text).toContain("waiting for locator('text=Nowhere')")
    expect(missing.text.split('Timeout 2000ms exceeded').length).toBe(2)
  } finally {
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})

it('saves screenshots at the given path, relative to the conversation cwd, creating parents', async () => {
  const directory = await temp('ultimate-browser-path-')
  const closers: (() => Promise<void>)[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: join(directory, 'project'),
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
    implement() {},
  } as unknown as ExtensionHost
  const tools = new Map(browserExtension(host).tools!.map((tool) => [tool.name, tool]))
  const cwd = join(directory, 'worktree')
  const api = (env = true) =>
    ({ env: env ? { cwd } : undefined, output() {} }) as unknown as ToolExecutionApi
  const url = 'data:text/html,<title>Shot</title><p>hello</p>'
  const file = async (name: string, args: Record<string, unknown>, env?: boolean) => {
    const result = await tools.get(name)!.execute({ url, waitMs: 0, ...args }, api(env), context)
    expect(result.isError).toBeFalsy()
    // Codemode reads this structured result; the model reads the PNG line of the output.
    const saved = (result as { structuredContent?: { file: string } }).structuredContent!.file
    await access(saved)
    expect(JSON.stringify(result.output)).toContain(`PNG: ${saved}`)
    return saved
  }
  try {
    expect(await file('screenshot', { path: join(directory, 'a/b/absolute.png') })).toBe(
      join(directory, 'a/b/absolute.png'),
    )
    expect(await file('screenshot', { path: 'shots/new/relative.png' })).toBe(
      join(cwd, 'shots/new/relative.png'),
    )
    expect(await file('browser', { path: 'steps/browser.png', steps: [] })).toBe(
      join(cwd, 'steps/browser.png'),
    )
    expect(await file('screenshot', { path: 'no-env.png' }, false)).toBe(
      join(host.projectRoot, 'no-env.png'),
    )
    expect(await file('screenshot', {})).toMatch(new RegExp(`^${host.home}/screenshots/.+\\.png$`))
    const wrong = await tools
      .get('screenshot')!
      .execute({ path: '/?conversation=1' }, api(), context)
    expect(wrong.isError).toBe(true)
    expect(JSON.stringify(wrong.output)).toContain('must end in .png')
  } finally {
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})

it('opens local pages only: refuses a public URL and blocks a redirect or request leaving the scope', async () => {
  const directory = await temp('ultimate-browser-scope-')
  const closers: (() => Promise<void>)[] = []
  // 203.0.113.0/24 is a documentation range: public, and never reached, since the proxy refuses it before connecting.
  const outside = 'http://203.0.113.7/'
  const server = createServer((request, response) => {
    if (request.url === '/away') response.writeHead(302, { location: outside }).end()
    else response.end(`<title>Local</title><img src="${outside}pixel.png">`)
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const host = {
    home: join(directory, 'home'),
    projectRoot: directory,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    system: () => ({ process: { url: `${local}/` } }),
    implement() {},
  } as unknown as ExtensionHost
  const browser = browserExtension(host).tools!.find((tool) => tool.name === 'browser')!
  const api = { output() {} } as unknown as ToolExecutionApi
  const drive = async (url: string) => {
    const result = await browser.execute(
      { url, steps: [{ eval: 'location.href' }], screenshot: false },
      api,
      context,
    )
    return { isError: result.isError, text: JSON.stringify(result.output) }
  }
  try {
    const refused = await drive(outside)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(`Refused ${outside}: 203.0.113.7 is a public address`)
    expect(refused.text).toContain('read public pages with web_fetch')

    const page = await drive('/')
    expect(page.isError).toBeFalsy()
    expect(page.text).toContain(`Step 1: OK \\"${local}/\\"`)
    expect(page.text).toContain(`Blocked ${outside}pixel.png: 203.0.113.7 is a public address`)

    const redirected = await drive('/away')
    expect(redirected.isError).toBe(true)
    expect(redirected.text).toContain(`Blocked ${outside}: 203.0.113.7 is a public address`)
    expect(redirected.text).not.toContain('Step 1: OK')
  } finally {
    for (const close of closers) await close()
    server.close()
    await removeTemp(directory)
  }
})

it('calls a Chromium older than the recorded minimum stale', async () => {
  const directory = await temp('ultimate-chromium-version-')
  const binary = join(directory, 'chromium')
  const answering = async (version: string) => {
    await writeFile(binary, `#!/bin/sh\necho "Chromium ${version} Test"\n`)
    await chmod(binary, 0o755)
    return chromiumStatus(binary)
  }
  try {
    expect(await answering('156.0.8078.47')).toMatchObject({
      version: '156.0.8078.47',
      stale: expect.stringContaining(`fixed in ${MINIMUM_CHROMIUM}`),
    })
    expect(await answering(MINIMUM_CHROMIUM)).toEqual({ path: binary, version: MINIMUM_CHROMIUM })
  } finally {
    await removeTemp(directory)
  }
})
