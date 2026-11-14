import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { context, prepareHarness } from '../../../../server/harness.ts'
import type { OpenHost } from '../../../../server/harness.ts'
import backgroundExtension from '../../server.ts'
import { resultIn } from '../../../conversations/server.ts'
import { conclude, concludedIds } from '../../../../lib/concluded.ts'
import { UiState } from '../../../../server/ui-state.ts'
import type { BackgroundResult } from '../../refs.ts'
import codingTools from '../../../coding-tools/server.ts'
import { writeJson } from '../../../../lib/json-file.ts'
import { readSlot } from '../../../../lib/slot.ts'

/**
 * The machine as the heavy-work queue reads it. `load`: idle, so a busy test machine never holds a job back. `cpuMs`: the
 * CPU time every measured command has used so far, while a test scripts it instead of burning cores; else measured.
 */
const machine = vi.hoisted(() => ({
  load: { load: 0, cores: 6, pressure: 0 },
  cpuMs: undefined as (() => number) | undefined,
}))
vi.mock('../../../../lib/cpu.ts', async (original) => {
  const actual = await original<typeof import('../../../../lib/cpu.ts')>()
  return {
    ...actual,
    machineLoad: async () => machine.load,
    sessionCpuMs: async (sid: number) => machine.cpuMs?.() ?? actual.sessionCpuMs(sid),
  }
})
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
      projectSettings: async () => ({}),
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
      projectSettings: async () => ({}),
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
      projectSettings: async () => ({}),
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
    JSON.stringify((await caller.context(context)).entries).includes('waiting for memory'),
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
      projectSettings: async () => ({}),
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
 * heavy commands share one heavy-work queue. `settings` are the machine's (user settings), `projectSettings` the
 * project's own.
 */
async function project(name: string, settings?: object, projectSettings: JsonObject = {}) {
  const root = await temp(`ultimate-background-${name}-`)
  if (settings) await writeJson(join(root, 'user/.ultimate/settings.json'), settings)
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
      projectSettings: async () => projectSettings,
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
    (): string[] => [],
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
    (await b.transcript()).includes(
      'Queued, next in line for the heavy-work slot, 1 of 1 heavy jobs running, behind',
    ),
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

// #227574: a command light at its probation that turns heavy later must not run beside a full queue.
it('ends a command that turns heavy without a place while every place is taken, and says why', async () => {
  const shared = await temp('ultimate-background-queue-')
  const log = join(shared, 'order')
  // Measured, with one place; the machine reads idle here (`machine`), so places alone decide.
  const a = await project('a', { cpu: { maxLoadPerCore: 1 }, heavyWork: { maxJobs: 1 } })
  // Its CPU time is scripted: idle, then two cores from `burning` on. Three real busy loops were measured above a core
  // only while the machine left them one: beside a CI shard's other workers they fell to a core or less between two
  // looks, each of which starts the 20 s over, and the test timed out (#260340, #261309). The measuring of a real
  // session is cpu-session.test.ts's.
  let burning: number | undefined
  machine.cpuMs = () => (burning === undefined ? 0 : 2 * (performance.now() - burning))
  const late = `echo late-start >> ${log}; sleep 600`
  try {
    await a.run(late)
    await until(async () => (await lines(log)).includes('late-start'))
    // Light through its probation, it gives its place back; a heavy command takes it.
    await until(async () => (await readSlot()).queue.entries.length === 0, 60_000)
    await a.run(heavy(log, 'hold', { hold: join(shared, 'go') }))
    await until(async () => (await lines(log)).includes('hold-start'))
    burning = performance.now()
    await until(async () => (await a.results()).length === 1, 90_000)
    const [stopped] = await a.results()
    expect(stopped).toMatchObject({ command: late, outcome: 'stopped' })
    expect(stopped.note).toContain('The heavy-work queue ended it')
    expect(stopped.note).toContain('Run it again with the same call')
  } finally {
    // Whatever happened, nothing of it holds the queue the next tests share.
    await a.caller.abort(context, { background: true })
    machine.cpuMs = undefined
  }
  // Its rules take that long: a 20 s probation, then 20 s above a core, and the looks between (44 s here, more on CI).
}, 180_000)

it("runs a listed command on the project's remote runner first, here when that gives no result, and says where", async () => {
  const scripts = await temp('ultimate-background-runner-')
  // A stand-in for a project's runner: it "runs" the command elsewhere and exits with 3, or says the machine is busy.
  const runner = join(scripts, 'runner.sh')
  await writeFile(
    runner,
    [
      'echo "runner for $ULTIMATE_REMOTE_HOST: $ULTIMATE_REMOTE_COMMAND"',
      'case "$ULTIMATE_REMOTE_COMMAND" in',
      `  *busy*) echo '{"ran":false,"reason":"busy with another run"}' > "$ULTIMATE_REMOTE_STATUS"; exit 75;;`,
      'esac',
      `echo '{"ran":true,"transferSeconds":1.5,"setupSeconds":6,"runSeconds":14,"cpuSeconds":31}' > "$ULTIMATE_REMOTE_STATUS"`,
      'exit 3',
    ].join('\n'),
  )
  const a = await project(
    'remote',
    { remoteJobs: { host: 'my-pc' } },
    { remoteJobs: { runner: `sh ${runner}`, commands: ['echo'] } },
  )
  for (const [index, command] of ['echo there', 'echo busy here', 'printf unlisted'].entries()) {
    await a.run(command)
    await until(async () => (await a.results()).length === index + 1)
  }
  const results = await a.results()
  const of = (command: string) => results.find((result) => result.command === command)
  // It ran there: the runner's exit code and timings, and nothing of the command ran here.
  expect(of('echo there')).toMatchObject({
    outcome: 'finished',
    exitCode: 3,
    where: {
      kind: 'remote',
      host: 'my-pc',
      timings: { transferSeconds: 1.5, setupSeconds: 6, runSeconds: 14, cpuSeconds: 31 },
    },
    tail: 'runner for my-pc: echo there\n',
  })
  // No result there: the same command ran here, after the runner's output in the same log.
  expect(of('echo busy here')).toMatchObject({
    outcome: 'finished',
    exitCode: 0,
    where: { kind: 'here-after', host: 'my-pc', reason: 'busy with another run' },
    tail: 'runner for my-pc: echo busy here\nbusy here\n',
  })
  expect(of('printf unlisted')).toMatchObject({ exitCode: 0, where: { kind: 'here' } })
  // The agent reads where each ran, in the tool's answer and in the result.
  const transcript = await a.transcript()
  expect(transcript).toContain('Sent to my-pc first')
  expect(transcript).toContain('Ran on my-pc in 14 s: 31 s of CPU there')
  expect(transcript).toContain('Ran here: my-pc gave no result (busy with another run).')
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
