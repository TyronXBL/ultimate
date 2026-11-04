import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import codingTools from '../../extensions/coding-tools/server.ts'
import { writeJson } from '../../lib/json-file.ts'
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
  prepared.registry.install(
    backgroundExtension({
      projectRoot: root,
      home: `${root}/home`,
      userHome: `${root}/user`,
    }),
  )
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

it('waits for RAM below the floor and starts once the floor allows it', async () => {
  const root = await temp('ultimate-background-')
  const settings = join(root, 'user/.ultimate/settings.json')
  // No machine has this much RAM free: the command waits.
  await writeJson(settings, { memory: { minAvailableMiB: 10 ** 9 } })
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: await temp(),
    home: `${root}/home`,
    faux: fauxProvider(),
  })
  prepared.registry.install(
    backgroundExtension({ projectRoot: root, home: `${root}/home`, userHome: `${root}/user` }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('background', { command: `touch ran; : pnpm test` })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('Queued.')]),
  ])
  const opened = await prepared.open()
  hosts.push(opened)
  const caller = opened.root
  await caller.submit({ type: 'input', requestId: 'wait', content: 'Run tests' }, context)
  await until(async () =>
    JSON.stringify((await caller.context(context)).entries).includes('Waiting for RAM'),
  )
  expect(existsSync(join(root, 'ran'))).toBe(false)
  await writeJson(settings, {})
  await until(async () =>
    (await caller.context(context)).entries.some((entry) => entry.kind === 'background.result'),
  )
  expect(existsSync(join(root, 'ran'))).toBe(true)
})

it('steers the calling run and wakes an interruptible wait when the command finishes', async () => {
  const root = await temp('ultimate-background-')
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: await temp(),
    home: `${root}/home`,
    faux: fauxProvider(),
  })
  prepared.registry.install(
    backgroundExtension({ projectRoot: root, home: `${root}/home`, userHome: `${root}/user` }),
  )
  prepared.registry.install(
    codingTools({
      emit: async () => undefined as never,
      projectRoot: root,
      skills: () => [],
      userHome: `${root}/user`,
    }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('background', {
          command: "until [ -f waiting ]; do sleep 0.05; done; printf 'done\\n'",
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      [fauxToolCall('bash', { command: 'touch waiting; sleep 60', interruptible: true })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('Handled in the same run.')]),
  ])
  const opened = await prepared.open()
  hosts.push(opened)
  const caller = opened.root
  await caller.submit({ type: 'input', requestId: 'wait-steer', content: 'Run and wait' }, context)
  await until(async () =>
    JSON.stringify((await caller.context(context)).entries).includes('Handled in the same run.'),
  )
  const entries = (await caller.context(context)).entries
  expect(JSON.stringify(entries)).toContain('Interrupted by a steering message')
  const resultIndex = entries.findIndex((entry) => entry.kind === 'background.result')
  const finalIndex = entries.findLastIndex((entry) => entry.kind === 'pi.assistant')
  expect(resultIndex).toBeGreaterThan(-1)
  expect(resultIndex).toBeLessThan(finalIndex)
})
