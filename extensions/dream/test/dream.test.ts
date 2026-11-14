import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { writeJson } from '../../../lib/json-file.ts'
import { prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { Metadata } from '../../../server/metadata.ts'
import { callTrace } from '../../../server/trace.ts'
import { docs as lineageDocs } from '../../lineage/server.ts'
import { Messages } from '../../messages/api.ts'
import { Todos } from '../../todos/server.ts'
import { Standing } from '../../subagents/api.ts'
import { ContextUsageDoc } from '../../conversations/api.ts'
import { underwayService } from '../../conversations/server.ts'
import automations, { actions as automationActions, Automations } from '../../automations/server.ts'
import dream, { actions, branched, Next, toolStats, userActions } from '../server.ts'
import type { Journey, Prepared } from '../refs.ts'
import { awakeOf, dreamStep } from '../state.ts'
import type { DreamEvent } from '../state.ts'
import {
  AUTOMATION_NAME,
  BuiltInDoc,
  ensureAutomation,
  PAUSE_NAME,
  PauseDoc,
} from '../built-ins.ts'
import { apis, eventHost, temp, until } from '../../../test/helpers.ts'

const openedHosts: OpenHost[] = []
/** The extensions' close callbacks: automations' minute timer stops before its harness closes. */
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  // Both lists before the first await, so a hook past its timeout cannot close the next test's hosts.
  const closing = closers.splice(0)
  const hosts = openedHosts.splice(0)
  for (const close of closing) await close()
  for (const opened of hosts) await opened.close()
  vi.useRealTimers()
})

/** A real harness with automations and dream installed, and @ultimate. */
async function fixture() {
  const home = await temp('ultimate-dream-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const openers: (() => Promise<void>)[] = []
  const tokens = [...lineageDocs, Messages, Todos]
  const resources = new Map<string, unknown>()
  const events = eventHost(() => opened.harness, 'test')
  const services = apis(
    new Map<string, unknown>([
      ['messages', { send: async () => ({}) }],
      ['lineage', { rootOf: async () => undefined }],
      ['conversations', underwayService({ resource: (_key, create) => create() })],
      [
        'subagents',
        {
          standing: async () =>
            (await opened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.ultimate,
        },
      ],
    ]),
  )
  const invoke = vi.fn<ExtensionHost['invoke']>(async (extension, action, args) => {
    if (extension !== 'automations') throw new Error(`Unexpected ${extension}/${action}`)
    return automationActions[action as 'list'](args, { host } as ActionContext)
  })
  const host = {
    ...prepared,
    ...events,
    ...services,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    metadata: Metadata,
    onRelease: () => {},
    onClose: (callback: () => Promise<void>) => void closers.push(callback),
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    projectSetup: async () => ({ decision: false }),
    projectSettings: async () => ({}),
    extensions: () => [
      { name: 'subagents', enabled: true },
      { name: 'automations', enabled: true },
    ],
    conversations: () => [],
    doc: (kind: string) =>
      tokens.find((token) => token.definition.kind === kind) ?? events.doc(kind),
    notice: () => {},
    invoke,
  } as unknown as ExtensionHost
  prepared.registry.install(automations(host))
  prepared.registry.install(dream(host))
  opened = await prepared.open(false)
  openedHosts.push(opened)
  const ultimate = await opened.harness.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, created.id, {})
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = created.id
    return created.id
  }, context)
  for (const open of openers) await open()
  await events.start()
  const harness = opened.harness
  const own = async () => (await harness.snapshot(BuiltInDoc, ROOT_CONVERSATION_ID, context))?.id
  const ownPause = async () => (await harness.snapshot(PauseDoc, ROOT_CONVERSATION_ID, context))?.id
  const ids = async () => Object.keys((await harness.snapshot(Automations, context))!.automations)
  const record = async (id: string) =>
    (await harness.snapshot(Automations, context))!.automations[id]
  /** @ultimate's context usage, as conversations measures it after an answer. */
  const usage = (percent: number) =>
    harness.commit(async (tx) => {
      Object.assign(await tx.doc(ContextUsageDoc, ultimate), {
        percent,
        tokens: percent * 10000,
        window: 1000000,
        at: Date.now(),
      })
    }, context)
  /** @ultimate's `dream.*` submissions, oldest first: their request ids and types. */
  const requests = () =>
    harness.commit(async (tx) => {
      const deliveries = (await tx.scanTasks({ kind: 'dream.deliver' }, 50)).items
      const found = []
      for (const task of deliveries) {
        const { requestId } = task.input as { requestId: string }
        const submission = await tx.submissionByRequest(ultimate, requestId)
        if (submission) found.push({ requestId, type: submission.type })
      }
      return found
    }, context)
  return {
    host,
    harness,
    ultimate,
    own,
    ownPause,
    ids,
    record,
    usage,
    requests,
    settle: () => until(events.settled),
    call: { host, conversationId: ultimate } as unknown as ActionContext,
    action: (name: keyof typeof automationActions, args: JsonValue = {}) =>
      automationActions[name](args, {
        host,
        conversationId: ultimate,
      } as unknown as ActionContext),
  }
}

it('ships both built-in triggers, each waking @ultimate, and keeps a deletion', async () => {
  const f = await fixture()
  const id = (await f.own())!
  const pause = (await f.ownPause())!
  expect(await f.record(id)).toMatchObject({
    name: AUTOMATION_NAME,
    enabled: true,
    condition: { metric: 'context', of: '@ultimate', above: 70, armed: true },
    subscribers: ['@ultimate'],
  })
  expect(await f.record(pause)).toMatchObject({
    name: PAUSE_NAME,
    enabled: true,
    condition: { of: '@ultimate', above: 50, idleFor: 8 * 3600_000 },
    subscribers: ['@ultimate'],
  })
  // Opening again (a facet reload, a restart) makes no second one.
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([id, pause])
  // The user deletes it: it stays deleted.
  await f.action('delete', { id })
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([pause])
})

it('adopts its own automation after a lost receipt, and keeps a chapter seed paused or deleted', async () => {
  const f = await fixture()
  const id = (await f.own())!
  await f.action('update', { id, condition: { metric: 'context', of: '@ultimate', above: 80 } })
  await f.action('pause', { id })
  // The create committed but its receipt was lost: its key returns it, not made twice, the user's threshold kept.
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)).id
  }, context)
  await ensureAutomation(f.host)
  expect(await f.own()).toBe(id)
  expect(await f.ids()).toEqual([id, await f.ownPause()])
  expect(await f.record(id)).toMatchObject({ enabled: false, condition: { above: 80 } })
  // A new chapter whose seed carried it paused makes it paused; one whose seed had it deleted makes none.
  const forget = () =>
    f.harness.commit(async (tx) => {
      const doc = await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)
      delete doc.id
      delete doc.deleted
    }, context)
  await f.action('delete', { id })
  await forget()
  await writeJson(`${f.host.chapter.dir}/seed.json`, { builtIn: { enabled: false } })
  await ensureAutomation(f.host)
  const made = (await f.own())!
  expect((await f.record(made)).enabled).toBe(false)
  await f.action('delete', { id: made })
  await forget()
  await writeJson(`${f.host.chapter.dir}/seed.json`, { builtIn: null })
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([await f.ownPause()])
})

it("asks @ultimate to dream on a built-in's fire, beside the fire's own wake-up, once per fire", async () => {
  const f = await fixture()
  const id = (await f.own())!
  f.host.harness().resume()
  await f.usage(71)
  await f.settle()
  // The fire's own input wakes @ultimate; the dream ask is a passive write in that run, so it costs one turn.
  await until(async () => (await f.requests()).length === 1)
  expect(await f.requests()).toEqual([{ requestId: `dream.requested:${id}:1`, type: 'write' }])
  // Still above: no second fire, no second ask.
  await f.usage(75)
  await until(async () => (await f.record(id)).condition?.value === 75)
  expect(await f.requests()).toHaveLength(1)
})

it("asks @ultimate to dream on the user's Dream, prepares the next chapter, and replaces it", async () => {
  const f = await fixture()
  expect(userActions).toEqual(['start', 'ready', 'dismiss', 'asleep', 'switch'])
  expect(await actions.start(null, f.call)).toEqual({ requested: true })
  await until(async () => (await f.requests()).length === 1)
  expect((await f.requests())[0].type).toBe('input')
  const ready = {
    chapter: 'fresh-roots',
    learned: ['I learned one.', 'I keep two.', "I'd like three."],
    handoff: 'Open: the preview round.',
  }
  await expect(actions.prepare({ ...ready, learned: ['one'] }, f.call)).rejects.toThrow('3 lines')
  await expect(actions.prepare({ ...ready, chapter: '../escape' }, f.call)).rejects.toThrow(
    'chapter name',
  )
  await expect(actions.prepare({ ...ready, handoff: 'x'.repeat(12_001) }, f.call)).rejects.toThrow(
    'at most 12000',
  )
  const first = await actions.prepare(ready, f.call)
  expect(first).toMatchObject(ready)
  // Its card is a passive write: @ultimate's running turn reads it.
  await until(async () => (await f.requests()).length === 2)
  expect((await f.requests())[1]).toEqual({
    requestId: `dream.prepared:${first.at}`,
    type: 'write',
  })
  const second = await actions.prepare({ ...ready, chapter: 'second-try' }, f.call)
  expect((await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))?.journey).toEqual({
    state: 'prepared',
    prepared: second,
  })
})

it("marks the branch a dream request's turn started as the dream, and asks @ultimate to prepare on Fall asleep", async () => {
  const f = await fixture()
  const append = (kind: string, model?: { stopReason: string }) =>
    f.harness.commit(
      async (tx) =>
        (
          await tx.appendEntry(f.ultimate, {
            kind,
            ...(model
              ? {
                  model: [
                    {
                      role: 'assistant',
                      content: [],
                      stopReason: model.stopReason,
                    } as never,
                  ],
                }
              : {}),
          })
        ).id as number,
      context,
    )
  const mark = (id: number, call: number, by: number = f.ultimate) =>
    f.harness.commit((tx) => branched(tx, { id, by, call, at: 1000 + id }), context)
  const journeyOf = async () =>
    (await f.harness.snapshot(Next, ROOT_CONVERSATION_ID, context))!.journey
  const dreamOf = async () => {
    const journey = await journeyOf()
    return 'dream' in journey ? journey.dream : undefined
  }
  // An ordinary branch, with no dream request in its turn, is not a dream.
  await mark(900, await append('pi.assistant', { stopReason: 'toolUse' }))
  expect(await dreamOf()).toBeUndefined()
  const requested = await append('dream.requested')
  await append('pi.assistant', { stopReason: 'toolUse' })
  const call = await append('pi.assistant', { stopReason: 'toolUse' })
  // Started by another conversation in the same moment: not @ultimate's dream.
  await mark(901, call, 77)
  expect(await dreamOf()).toBeUndefined()
  // A chapter prepared after an earlier dream and never slept into kept hiding this dream's cue.
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Next, ROOT_CONVERSATION_ID)).journey = {
      state: 'prepared',
      prepared: { chapter: 'stale', learned: ['one', 'two', 'three'], handoff: 'old', at: 5000 },
    }
  }, context)
  await mark(902, call)
  expect(await journeyOf()).toEqual({
    state: 'woke',
    dream: { branch: 902, requested, at: 1902 },
  })
  // A later turn's branch, after @ultimate's answer ended the dream turn, leaves the dream as it was.
  await append('pi.assistant', { stopReason: 'stop' })
  await mark(903, await append('pi.assistant', { stopReason: 'toolUse' }))
  expect((await dreamOf())?.branch).toBe(902)
  // Fall asleep asks @ultimate to prepare, as an input that wakes it.
  const { asked } = await actions.ready(null, f.call)
  expect(await journeyOf()).toMatchObject({ state: 'preparing', asked })
  await until(async () => (await f.requests()).length === 1)
  expect(await f.requests()).toEqual([{ requestId: `dream.ready:${asked}`, type: 'input' }])
})

const PREPARED: Prepared = { chapter: 'fresh', learned: ['a', 'b', 'c'], handoff: 'h', at: 50 }
const DREAM = { branch: 7, requested: 10, at: 40 }
const LATER = { branch: 8, requested: 11, at: 60 }
const sleeping = (phase: 'seeding' | 'backing up' | 'switching', backup?: { id: string }) =>
  ({ state: 'sleeping', prepared: PREPARED, chapter: 'next', phase, at: 1, backup }) as const
const IDLE: Journey = { state: 'idle' }
const WOKE: Journey = { state: 'woke', dream: DREAM }
const PREPARING: Journey = { state: 'preparing', dream: DREAM, asked: 45 }
const PREPARED_STATE: Journey = { state: 'prepared', prepared: PREPARED, dream: DREAM }
const FAILED: Journey = {
  state: 'failed',
  prepared: PREPARED,
  chapter: 'next',
  backup: { id: 'b' },
  error: 'x',
  at: 2,
}
const ASLEEP: Journey = { state: 'asleep', prepared: PREPARED, chapter: 'next', at: 3 }
const dreamed = (recorded = LATER): DreamEvent => ({ type: 'dreamed', dream: recorded })
/** A refused event: the message it throws. */
const refused = (error: string) => ({ error })

it.each<[string, Journey, DreamEvent, Journey | { error: string }]>([
  ['records the first dream', IDLE, dreamed(DREAM), WOKE],
  ['a second branch of the recorded request is not a new dream', WOKE, dreamed(DREAM), WOKE],
  // A replayed event must not undo the preparation made after that dream.
  [
    'a replayed request does not unseat a prepared chapter',
    PREPARED_STATE,
    dreamed(DREAM),
    PREPARED_STATE,
  ],
  // The unslept preparation of an earlier dream kept hiding the new dream's Fall asleep cue (1037052).
  [
    'a newer dream supersedes an unslept preparation',
    PREPARED_STATE,
    dreamed(),
    { state: 'woke', dream: LATER },
  ],
  // Bug: it deleted the preparation under the running sleep, so the Fall asleep card lost the sleep.
  [
    'a dream during a sleep changes nothing',
    sleeping('backing up'),
    dreamed(),
    sleeping('backing up'),
  ],
  [
    'Fall asleep asks @ultimate to prepare',
    WOKE,
    { type: 'asked', at: 70 },
    { state: 'preparing', dream: DREAM, asked: 70 },
  ],
  [
    'Fall asleep needs a dream',
    IDLE,
    { type: 'asked', at: 70 },
    refused('No dream to wake from: start one with Dream'),
  ],
  [
    'Fall asleep refuses once prepared',
    PREPARED_STATE,
    { type: 'asked', at: 70 },
    refused('Chapter fresh is already prepared'),
  ],
  [
    'staying dismisses a woken dream',
    PREPARING,
    { type: 'dismissed' },
    { state: 'dismissed', dream: DREAM },
  ],
  [
    'staying does not turn a prepared chapter into a dismissed dream',
    PREPARED_STATE,
    { type: 'dismissed' },
    PREPARED_STATE,
  ],
  [
    'a preparation follows the dream it answers',
    PREPARING,
    { type: 'prepared', prepared: PREPARED },
    PREPARED_STATE,
  ],
  [
    'no preparation while a sleep runs',
    sleeping('switching'),
    { type: 'prepared', prepared: PREPARED },
    refused('Falling asleep is under way (switching)'),
  ],
  [
    'a sleep starts on the prepared name',
    PREPARED_STATE,
    { type: 'sleep started', at: 1 },
    { ...sleeping('seeding'), chapter: 'fresh', dream: DREAM },
  ],
  [
    'a failed sleep retries under a new name and forgets the old backup',
    FAILED,
    { type: 'sleep started', chapter: 'next', at: 1 },
    sleeping('seeding'),
  ],
  [
    'a slept-into chapter cannot be slept into again',
    ASLEEP,
    { type: 'sleep started', at: 1 },
    refused('Already asleep in next: @ultimate prepares the next chapter first'),
  ],
  [
    'one sleep at a time',
    sleeping('seeding'),
    { type: 'sleep started', at: 1 },
    refused('Falling asleep is under way (seeding)'),
  ],
  [
    'a step fails the sleep with the backup so far',
    sleeping('switching', { id: 'b' }),
    { type: 'failed', error: 'x', at: 2 },
    FAILED,
  ],
  [
    'progress cannot skip a step',
    sleeping('seeding'),
    { type: 'switching', at: 5 },
    refused('Falling asleep cannot switch from seeding'),
  ],
  [
    'the switch needs the backup result first',
    sleeping('backing up'),
    { type: 'switching', at: 5 },
    refused('Falling asleep cannot switch before the backup is recorded'),
  ],
  [
    'progress cannot finish early',
    sleeping('backing up'),
    { type: 'asleep', at: 5 },
    refused('Falling asleep cannot finish from backing up'),
  ],
  [
    'progress needs a running sleep',
    FAILED,
    { type: 'switching', at: 5 },
    refused('No sleep is running to switch'),
  ],
])('journey: %s', (_name, from, event, expected) => {
  const outcome = (() => {
    try {
      return dreamStep(from, event)
    } catch (error) {
      return refused((error as Error).message)
    }
  })()
  expect(outcome).toEqual(expected)
})

it.each<[string, Journey, boolean, unknown]>([
  ['shows nothing while the dream branch runs', WOKE, false, undefined],
  ['shows the finished dream', WOKE, true, { phase: 'woke', branch: 7 }],
  [
    'shows a prepared chapter, also while its sleep failed',
    FAILED,
    true,
    { phase: 'prepared', chapter: 'fresh' },
  ],
])('awake: %s', (_name, journey, concluded, expected) => {
  expect(awakeOf(journey, () => concluded)).toEqual(expected)
})

it('reads tool numbers from the trace, with unused tools and frequent errors', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE calls (id TEXT, at REAL, ms REAL, kind TEXT, name TEXT, ok INTEGER, error TEXT, args TEXT, conversation INTEGER, entry INTEGER, caller TEXT)',
  )
  const insert = db.prepare(
    'INSERT INTO calls (id, at, ms, kind, name, ok, error, args, conversation, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insert.run('1', 100, 10, 'tool', 'edit', 1, null, null, null, null)
  insert.run(
    '2',
    200,
    30,
    'tool',
    'edit',
    0,
    'Could not find the exact text',
    '{"path":"a.ts"}',
    7,
    42,
  )
  insert.run('3', 300, 5, 'tool', 'read', 1, null, null, null, null)
  insert.run('4', 50, 5, 'action', 'dream/stats', 1, null, null, null, null)
  db.close()
  expect(toolStats(file, ['edit', 'read', 'notify'], [])).toEqual({
    interpretation:
      'Reads through bash are not traced. Tool durations are wall time, including deliberate waits; tool failure counts exclude model-call failures.',
    since: 100,
    calls: 3,
    tools: [
      { name: 'edit', calls: 2, failed: 1, avgMs: 20 },
      { name: 'read', calls: 1, failed: 0, avgMs: 5 },
    ],
    unused: ['notify'],
    errors: [
      {
        name: 'edit',
        error: 'Could not find the exact text',
        count: 1,
        examples: [{ at: '#7/42', args: '{"path":"a.ts"}' }],
      },
    ],
    skills: [],
    skillsWithNoTracedUse: [],
  })
  expect(toolStats(join(await temp(), 'none.sqlite'), ['read'], ['ship'])).toMatchObject({
    unused: ['read'],
    skillsWithNoTracedUse: ['ship'],
  })
})

it('counts skill reads and runs from the trace, with failed reads and listed skills with no traced use', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const trace = callTrace(file)
  trace.open()
  const [read] = trace.tools({
    name: 'coding-tools',
    tools: [
      {
        name: 'read',
        execute: async ({ path }: { path: string }) => {
          if (path.startsWith('/home/')) throw new Error(`ENOENT: no such file, open '${path}'`)
          return { output: [] }
        },
      } as never,
    ],
  }).tools!
  const api = { conversationId: 1, taskId: 1, callId: 'call', getTask: async () => undefined }
  const call = (path: string) => read.execute({ path }, api as never, {} as never)
  await call('/clone/skills/ship/SKILL.md')
  await call('.ultimate/skills/ship/SKILL.md')
  await call('docs/README.md')
  // A project skill looked for in the personal folder.
  await expect(call('/home/user/.ultimate/skills/audit/SKILL.md')).rejects.toThrow('ENOENT')
  // `/skill:ship` from the composer, as the submit API marks it.
  trace
    .begin({ kind: 'skill', caller: 'user', callee: 'skills', name: 'ship', sealed: true }, null)
    .finish(true, undefined)
  trace.close()
  const stats = toolStats(file, ['read'], ['audit', 'ship', 'tidy'])
  expect(stats.skills).toEqual([
    { name: 'ship', reads: 2, runs: 1, failed: 0 },
    { name: 'audit', reads: 0, runs: 0, failed: 1 },
  ])
  expect(stats.skillsWithNoTracedUse).toEqual(['audit', 'tidy'])
  expect(stats.tools).toMatchObject([{ name: 'read', calls: 4, failed: 1 }])
  // Only the skill's name is kept, never the path it was read from.
  const db = new DatabaseSync(file, { readOnly: true })
  expect(db.prepare('SELECT count(*) AS n FROM calls WHERE args IS NOT NULL').get()).toEqual({
    n: 0,
  })
  expect(db.prepare("SELECT error FROM calls WHERE kind = 'skill' AND ok = 0").all()).toEqual([
    { error: 'Read failed' },
  ])
  db.close()
})
