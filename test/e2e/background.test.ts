import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { context, prepareHarness } from '../../server/harness.ts'
import type { OpenHost } from '../../server/harness.ts'
import backgroundExtension from '../../extensions/background/server.ts'
import type { BackgroundResult } from '../../extensions/background/refs.ts'
import { temp, until } from '../helpers.ts'

const run = promisify(execFile)
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

it('runs in the background and delivers one result; concluding its owner kills the process group', async () => {
  // Names this test's sleeper among every process on the machine.
  const marker = `background-test-${process.pid}-${Date.now()}`
  const sleeping = () =>
    run('pgrep', ['-f', marker]).then(
      () => true,
      () => false,
    )
  const root = await temp('ultimate-background-')
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: await temp(),
    home: `${root}/home`,
    faux: fauxProvider(),
  })
  prepared.registry.install(backgroundExtension({ projectRoot: root, home: `${root}/home` }))
  prepared.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('background', { command: "printf 'line one\\nline two\\n'; exit 3" })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('Started.')]),
    fauxAssistantMessage([fauxToolCall('background', { command: `sleep 60; : ${marker}` })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('Started.')]),
  ])
  const opened = await prepared.open()
  hosts.push(opened)
  const caller = opened.root
  await caller.submit({ type: 'input', requestId: 'first', content: 'Run command' }, context)
  await until(async () =>
    (await caller.context(context)).entries.some((entry) => entry.kind === 'background.result'),
  )
  const results = (await caller.context(context)).entries.filter(
    (entry) => entry.kind === 'background.result',
  )
  expect(results).toHaveLength(1)
  expect(results[0].data as BackgroundResult).toMatchObject({
    outcome: 'finished',
    exitCode: 3,
    tail: expect.stringContaining('line two'),
  })
  await caller.submit({ type: 'input', requestId: 'second', content: 'Start sleeper' }, context)
  await until(sleeping)
  // What concluding the conversation does to its background tasks.
  await caller.abort(context, { background: true })
  await until(async () => !(await sleeping()))
  expect(
    (await caller.context(context)).entries.filter((entry) => entry.kind === 'background.result'),
  ).toHaveLength(1)
})
