import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../../../../server/harness.ts'
import type { OpenHost } from '../../../../server/harness.ts'
import backgroundExtension from '../../server.ts'
import { resultIn } from '../../../conversations/server.ts'
import { conclude, concludedIds } from '../../../../lib/concluded.ts'
import { UiState } from '../../../../server/ui-state.ts'
import type { BackgroundResult } from '../../refs.ts'
import codingTools from '../../../coding-tools/server.ts'
import { writeJson } from '../../../../lib/json-file.ts'
import { temp, until } from '../../../../test/helpers.ts'

const run = promisify(execFile)
/** The one service background needs: the real rule for results to concluded conversations. */
const need = (() => ({ resultIn })) as never
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
      need,
      onOpen: () => {},
      onClose: () => {},
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

// #151003: a landing concludes a branch without stopping its jobs; a dev server or Postgres that ended later woke it.
it('leaves a note for a conversation concluded while its command ran, starting no run', async () => {
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
      need,
      onOpen: () => {},
      onClose: () => {},
    }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('background', { command: 'until [ -f stop ]; do sleep 0.05; done; exit 143' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('Started.')]),
  ])
  const opened = await prepared.open()
  hosts.push(opened)
  const caller = opened.root
  await caller.submit({ type: 'input', requestId: 'start', content: 'Start server' }, context)
  await caller.waitForIdle(context)
  await opened.harness.commit(
    async (tx) => conclude(await tx.doc(UiState, ROOT_CONVERSATION_ID), [caller.id], 1),
    context,
  )
  await writeFile(join(root, 'stop'), '')
  await until(async () =>
    (await caller.context(context)).entries.some((entry) => entry.kind === 'background.result'),
  )
  await caller.waitForIdle(context)
  const entries = (await caller.context(context)).entries
  expect(entries.at(-1)).toMatchObject({
    kind: 'background.result',
    data: { outcome: 'finished', exitCode: 143 },
    model: [
      { content: expect.stringMatching(/^Note \(recorded while this conversation was concluded/) },
    ],
  })
  expect(entries.filter((entry) => entry.kind === 'pi.assistant')).toHaveLength(2)
  expect(
    concludedIds((await opened.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context)) ?? {}),
  ).toEqual([caller.id])
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
    backgroundExtension({
      projectRoot: root,
      home: `${root}/home`,
      userHome: `${root}/user`,
      need,
      onOpen: () => {},
      onClose: () => {},
    }),
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
    JSON.stringify((await caller.context(context)).entries).includes('waiting for RAM'),
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
    backgroundExtension({
      projectRoot: root,
      home: `${root}/home`,
      userHome: `${root}/user`,
      need,
      onOpen: () => {},
      onClose: () => {},
    }),
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

/**
 * A project of its own, as another branch's or another project's host on the same machine: its root conversation runs
 * each `RUN <command>` input as a background command. Every project of a test file shares the file's TMPDIR, so their
 * heavy commands share one heavy-work queue.
 */
async function project(name: string) {
  const root = await temp(`ultimate-background-${name}-`)
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
      need,
      onOpen: () => {},
      onClose: () => {},
    }),
  )
  const route: FauxResponseFactory = (transcript) => {
    prepared.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    const text =
      typeof last.content === 'string'
        ? last.content
        : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    return last.role === 'user' && text.startsWith('RUN ')
      ? fauxAssistantMessage([fauxToolCall('background', { command: text.slice(4) })], {
          stopReason: 'toolUse',
        })
      : fauxAssistantMessage([fauxText('Noted.')])
  }
  prepared.faux!.setResponses([route])
  let opened = await prepared.open()
  hosts.push(opened)
  let inputs = 0
  const entries = async () => (await opened.root.context(context)).entries
  return {
    get caller() {
      return opened.root
    },
    run: (command: string) =>
      opened.root.submit(
        { type: 'input', requestId: `run-${++inputs}`, content: `RUN ${command}` },
        context,
      ),
    results: async () =>
      (await entries())
        .filter((entry) => entry.kind === 'background.result')
        .map((entry) => entry.data as BackgroundResult),
    /** Close the host and open it again on the same storage: a restart. */
    async restart() {
      await opened.close()
      hosts.splice(hosts.indexOf(opened), 1)
      opened = await prepared.open()
      hosts.push(opened)
    },
    transcript: async () => JSON.stringify(await entries()),
  }
}

/** A heavy command (it names `pnpm test`) that logs its start and end to `log`, holding until `hold` exists. */
const heavy = (
  log: string,
  name: string,
  { hold, exit = 0 }: { hold?: string; exit?: number } = {},
) =>
  [
    ': pnpm test',
    `echo ${name}-start >> ${log}`,
    ...(hold ? [`until [ -f ${hold} ]; do sleep 0.05; done`] : []),
    `echo ${name}-end >> ${log}`,
    `exit ${exit}`,
  ].join('; ')
const lines = (log: string) =>
  readFile(log, 'utf8').then(
    (text) => text.trim().split('\n'),
    // Nothing ran yet.
    () => [],
  )

it('runs heavy commands of two projects one at a time, in order; a failed one lets the next start', async () => {
  const shared = await temp('ultimate-background-queue-')
  const log = join(shared, 'order')
  const a = await project('a')
  const b = await project('b')
  await a.run(heavy(log, 'a', { hold: join(shared, 'go'), exit: 1 }))
  await until(async () => (await lines(log)).includes('a-start'))
  await b.run(heavy(log, 'b'))
  // Its answer says why it waits: behind which command, from which conversation and project.
  await until(async () =>
    (await b.transcript()).includes('Queued, next in line for the heavy-work slot, behind'),
  )
  expect(await b.transcript()).toMatch(
    /behind `: pnpm test; echo a-start[^`]*` from #\d+ in ultimate-background-a-/,
  )
  await writeFile(join(shared, 'go'), '')
  await until(async () => (await b.results()).length === 1)
  expect(await lines(log)).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  expect(await a.results()).toMatchObject([{ outcome: 'finished', exitCode: 1 }])
  expect(await b.results()).toMatchObject([
    { outcome: 'finished', exitCode: 0, queued: expect.any(Number) },
  ])
})

it('starts the next heavy command in line once the conversation running one is concluded', async () => {
  const shared = await temp('ultimate-background-queue-')
  const log = join(shared, 'order')
  const a = await project('a')
  const b = await project('b')
  await a.run(heavy(log, 'a', { hold: join(shared, 'never') }))
  await until(async () => (await lines(log)).includes('a-start'))
  await b.run(heavy(log, 'b'))
  await until(async () => (await b.transcript()).includes('Queued, next in line'))
  // What concluding the conversation does to its background tasks.
  await a.caller.abort(context, { background: true })
  await until(async () => (await b.results()).length === 1)
  expect(await lines(log)).toEqual(['a-start', 'b-start', 'b-end'])
  expect(await a.results()).toEqual([])
})

it('keeps a running and a waiting heavy command through a restart: each runs once, in order', async () => {
  const shared = await temp('ultimate-background-queue-')
  const log = join(shared, 'order')
  const a = await project('a')
  await a.run(heavy(log, 'first', { hold: join(shared, 'go') }))
  await until(async () => (await lines(log)).includes('first-start'))
  await a.run(heavy(log, 'second'))
  await until(async () => (await a.transcript()).includes('Queued, next in line'))
  await a.restart()
  await writeFile(join(shared, 'go'), '')
  await until(async () => (await a.results()).length === 2)
  expect(await lines(log)).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  expect((await a.results()).map((result) => result.command)).toEqual([
    heavy(log, 'first', { hold: join(shared, 'go') }),
    heavy(log, 'second'),
  ])
})
