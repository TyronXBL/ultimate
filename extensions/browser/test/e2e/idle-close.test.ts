// The shared Chromium stayed up until the host closed: idle trees held 370-513 MiB for over a day on a host that must
// keep 3 GB free (#273712). It now closes after a few idle minutes, and the next call launches a fresh one.
import { join } from 'node:path'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { context } from '../../../../server/harness.ts'
import browserExtension from '../../server.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { groupAlive } from '../../../../lib/process-group.ts'
import { removeTemp, temp, until } from '../../../../test/helpers.ts'

it('closes the shared browser after it idles, and the next call launches a fresh one', async () => {
  const directory = await temp('ultimate-browser-idle-')
  const closers: (() => Promise<void>)[] = []
  const host = {
    home: join(directory, 'home'),
    projectRoot: directory,
    resource: <T>(_name: string, create: () => T) => create(),
    onClose: (close: () => Promise<void>) => closers.push(close),
    notice() {},
    system: () => ({ process: { url: 'http://127.0.0.1:1/' } }),
    implement() {},
  } as unknown as ExtensionHost
  const browser = browserExtension(host).tools!.find((tool) => tool.name === 'browser')!
  const api = { output() {} } as unknown as ToolExecutionApi
  const drive = () =>
    browser.execute(
      { url: 'data:text/html,<title>Idle</title>', steps: [], screenshot: false },
      api,
      context,
    )
  const launch = vi.spyOn(chromium, 'launch')
  try {
    // Only the timers the call sets are fake, so the idle one can be skipped ahead without a real wait.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect((await drive()).isError).toBeFalsy()
    const first = await launch.mock.results[0].value
    const cdp = await first.newBrowserCDPSession()
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { type: string; id: number }[]
    }
    await cdp.detach()
    const pid = processInfo.find((info) => info.type === 'browser')!.id
    vi.advanceTimersByTime(5 * 60_000)
    vi.useRealTimers()
    await until(() => !groupAlive(pid))
    expect((await drive()).isError).toBeFalsy()
    expect(launch).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
    launch.mockRestore()
    for (const close of closers) await close()
    await removeTemp(directory)
  }
})
