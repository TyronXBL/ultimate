import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareHarness } from '../../../server/harness.ts'
import type { OpenHost } from '../../../server/harness.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import backupExtension from '../server.ts'
import { BackupApi } from '../api.ts'
import pauseExtension from '../../pause/server.ts'
import { PauseApi } from '../../pause/api.ts'
import { BackupOrder, ModelsApi, Pin } from '../../models/api.ts'
import modelsExtension from '../../models/server.ts'
import { Backups, Owner } from '../../models/set-model.ts'
import {
  backupOrder,
  backupStep,
  exhaustedStep,
  exhaustedUntil,
  jitterOf,
  waitUntil,
} from '../state.ts'
import type { Exhausted, ExhaustedEvent } from '../state.ts'
import type { BackupRecord } from '../../models/refs.ts'
import type { BackupState, ModelRef } from '../refs.ts'
import { Standing } from '../../subagents/api.ts'
import { ContextUsageDoc } from '../../conversations/api.ts'
import { apis, removeTemps, temp, until } from '../../../test/helpers.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  await removeTemps()
})

const rateLimit = 'status 429: This request would exceed your account rate limit, try again later.'
const quota = '429 You exceeded your current quota (insufficient_quota).'

/** The answer a provider gives when it hit a limit, stamped with the model that answered it. */
const limitedBy = (id: string, errorMessage: string): AssistantMessage => ({
  ...fauxAssistantMessage('', { stopReason: 'error', errorMessage }),
  model: id,
})

/** A faux harness with the backup extension and a definition whose backup models are `fallback`. */
async function fixture(fallback: string[] = ['faux/faux-2', 'faux/faux-3']) {
  const home = await temp('ultimate-backup-')
  // Pi retries a limit after 200 ms; the switch lands in that window, so the retry asks the backup model.
  await mkdir(join(home, '.pi'), { recursive: true })
  await writeFile(join(home, '.pi/settings.json'), JSON.stringify({ retry: { baseDelayMs: 200 } }))
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider({
      models: [
        { id: 'faux-1', reasoning: true },
        { id: 'faux-2', reasoning: true },
        { id: 'faux-3', reasoning: true },
      ],
    }),
  })
  let opened: OpenHost | undefined
  const services = apis()
  const resources = new Map<string, unknown>()
  const openers: (() => Promise<void>)[] = []
  const host = {
    ...services,
    harness: () => opened!.harness,
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    modelRuntime: prepared.modelRuntime,
    settings: prepared.settings,
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    onClose: () => {},
    onRelease: () => {},
    // No login changes here: the reactor for them never runs.
    react: () => {},
    conversations: () => [],
  } as unknown as ExtensionHost
  services.implement(Pin, {
    definition: async () => ({
      fallback: fallback.map((ref) => {
        const [provider, modelId] = ref.split('/')
        return { provider, modelId }
      }),
    }),
  })
  prepared.registry.install(modelsExtension(host))
  prepared.registry.install(backupExtension(host))
  prepared.registry.install(pauseExtension(host))
  /** Open as the server does: the openers settle first, then scheduling resumes. */
  const open = async () => {
    opened = await prepared.open(false)
    hosts.push(opened)
    for (const callback of openers) await callback()
    opened.harness.resume()
    return opened
  }
  return {
    home,
    prepared,
    open,
    get opened() {
      return opened!
    },
    backup: () => services.want(BackupApi)!,
    order: () => services.want(BackupOrder)!,
    models: () => services.want(ModelsApi)!,
    paused: () => services.want(PauseApi)!.paused(),
  }
}

const entries = async (harness: Harness, id: ConversationId) =>
  (await (await harness.conversation(id, context))!.context(context)).entries
const cards = async (harness: Harness, id: ConversationId) =>
  (await entries(harness, id)).filter((entry) => entry.kind === 'backup.switch')
const dividers = async (harness: Harness, id: ConversationId, kind: string) =>
  (await entries(harness, id)).filter((entry) => entry.kind === kind)
const agent = async (harness: Harness, id: ConversationId) =>
  (await harness.conversation(id, context))!.agent(context)
const state = (harness: Harness, id: ConversationId) => harness.snapshot(Owner, id, context)

it('switches to the next backup model on a rate limit, and the retry answers on it', async () => {
  const f = await fixture()
  const asked: string[] = []
  f.prepared.faux!.setResponses([
    (_context, _options, _state, model) => {
      asked.push(model.id)
      return limitedBy(model.id, rateLimit)
    },
    (_context, _options, _state, model) => {
      asked.push(model.id)
      return fauxAssistantMessage([fauxText('done')])
    },
  ])
  const { root, harness } = await f.open()
  const ultimate = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
  }, context)

  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  expect((await submission.wait(context)).status).toBe('done')
  await until(async () => (await cards(harness, root.id)).length === 1)
  // Pi's retry waited out the backoff on the model the switch set.
  expect(asked).toEqual(['faux-1', 'faux-2'])
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-2' })
  const [card] = await cards(harness, root.id)
  expect(card.data).toEqual({
    from: 'faux/faux-1',
    to: 'faux/faux-2',
    reason: 'rate limit',
    error: rateLimit,
    cooldown: 30,
  })
  const record = await state(harness, root.id)
  expect(record).toMatchObject({
    by: 'backup',
    primary: { provider: 'faux', modelId: 'faux-1' },
    to: { provider: 'faux', modelId: 'faux-2' },
    tried: ['faux/faux-1'],
  })
  expect((record as BackupRecord).since).toBeGreaterThan(Date.now() - 60_000)
  // @ultimate hears about it once, in its own conversation.
  const notices = await dividers(harness, ultimate.id, 'backup.notice')
  expect(notices).toHaveLength(1)
  expect(notices[0].data).toEqual({
    conversation: root.id,
    from: 'faux/faux-1',
    to: 'faux/faux-2',
    reason: 'rate limit',
  })
})

it('takes the next backup on a second limit, keeping the first primary', async () => {
  const f = await fixture()
  let responses = 0
  f.prepared.faux!.setResponses([
    () => {
      responses++
      return limitedBy('faux-1', quota)
    },
    () => {
      responses++
      return limitedBy('faux-2', quota)
    },
    () => {
      responses++
      return fauxAssistantMessage([fauxText('done')])
    },
  ])
  const { root, harness } = await f.open()
  await harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, root.id)).model = { provider: 'faux', modelId: 'faux-1' }
  }, context)
  // A quota error ends the run, so the switch is taken by the next one.
  expect(
    (await (await root.submit({ type: 'input', content: 'A' }, context)).wait(context)).status,
  ).toBe('unanswered')
  await until(async () => (await cards(harness, root.id)).length === 1)
  const second = await root.submit({ type: 'input', content: 'B' }, context)
  await until(async () => (await cards(harness, root.id)).length === 2)
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-3' })
  expect((await cards(harness, root.id)).map((card) => card.data)).toMatchObject([
    { from: 'faux/faux-1', to: 'faux/faux-2', reason: 'quota' },
    { from: 'faux/faux-2', to: 'faux/faux-3', reason: 'quota' },
  ])
  const record = await state(harness, root.id)
  expect(record).toMatchObject({
    by: 'backup',
    primary: { provider: 'faux', modelId: 'faux-1' },
    to: { provider: 'faux', modelId: 'faux-3' },
    tried: ['faux/faux-1', 'faux/faux-2'],
  })
  // No backup after the last one: the run fails on it and the record stands for the next one.
  expect(responses).toBe(2)
  expect((await second.wait(context)).status).toBe('unanswered')
})

it('leaves the host running for a rate limit a backup model takes', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    (_context, _options, _state, model) => limitedBy(model.id, rateLimit),
    (_context, _options, _state, model) => fauxAssistantMessage([fauxText(`done on ${model.id}`)]),
  ])
  const { root, harness } = await f.open()
  const ultimate = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  await harness.commit(async (tx) => {
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
  }, context)

  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  expect((await submission.wait(context)).status).toBe('done')
  await until(async () => (await cards(harness, root.id)).length === 1)
  // The failed answer was the only one on the primary: Pi's retry ran on the backup, and nothing paused the host.
  expect(f.paused()).toBe(false)
  expect((await harness.inspect(context)).scheduling).toBe('running')
  expect(await dividers(harness, ultimate.id, 'pause.limit')).toEqual([])
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-2' })
})

it('waits on its primary instead of pausing the host when no backup fits, and the primary’s answer ends the wait', async () => {
  const f = await fixture(['faux/faux-2'])
  f.prepared.faux!.setResponses([
    (_context, _options, _state, model) => limitedBy(model.id, rateLimit),
    (_context, _options, _state, model) => fauxAssistantMessage([fauxText(`done on ${model.id}`)]),
  ])
  const { root, harness } = await f.open()
  // The backup's 128k window has no room for 100k and the answer's reserve.
  await harness.commit(async (tx) => {
    ;(await tx.doc(ContextUsageDoc, root.id)).tokens = 100_000
  }, context)
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await until(async () => (await dividers(harness, root.id, 'backup.wait')).length === 1)
  expect((await submission.wait(context)).status).toBe('done')
  expect(f.paused()).toBe(false)
  await until(async () => (await state(harness, root.id))?.by === 'default')
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect(await cards(harness, root.id)).toEqual([])
})

it('stays on its model when the answer failed for another reason', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => limitedBy('faux-1', '401 invalid api key'),
    () => fauxAssistantMessage([fauxText('ok')]),
  ])
  const { root, harness } = await f.open()
  await harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, root.id)).model = { provider: 'faux', modelId: 'faux-1' }
  }, context)
  expect(
    (await (await root.submit({ type: 'input', content: 'A' }, context)).wait(context)).status,
  ).toBe('unanswered')
  expect(await cards(harness, root.id)).toEqual([])
  expect(await state(harness, root.id)).toEqual({ by: 'default' })
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-1' })
})

it('returns to the primary at a run that starts after the cooldown', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => limitedBy('faux-1', rateLimit),
    () => fauxAssistantMessage([fauxText('done')]),
    () => fauxAssistantMessage([fauxText('again')]),
  ])
  const { root, harness } = await f.open()
  const submission = await root.submit({ type: 'input', content: 'go' }, context)
  await submission.wait(context)
  await until(async () => (await cards(harness, root.id)).length === 1)
  // A subagent's row and card say it runs on a backup while it does.
  const shown = () => harness.snapshot(Backups, ROOT_CONVERSATION_ID, context)
  expect(await shown()).toEqual({
    [root.id]: { from: 'faux/faux-1', model: 'faux-2', reason: 'rate limit' },
  })
  // The cooldown passed while the conversation was idle on the backup.
  await harness.commit(async (tx) => {
    Object.assign(await tx.doc(Owner, root.id), { since: Date.now() - 31 * 60_000 })
  }, context)

  expect(
    (await (await root.submit({ type: 'input', content: 'next' }, context)).wait(context)).status,
  ).toBe('done')
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  const [divider] = await dividers(harness, root.id, 'backup.return')
  expect(divider.data).toEqual({ from: 'faux/faux-2', to: 'faux/faux-1' })
  expect(await state(harness, root.id)).toEqual({ by: 'default' })
  expect(await shown()).toEqual({})
})

it('returns only once the cooldown passed', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => limitedBy('faux-1', rateLimit),
    () => fauxAssistantMessage([fauxText('done')]),
    () => fauxAssistantMessage([fauxText('still backed up')]),
  ])
  const { root, harness } = await f.open()
  await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context)
  await until(async () => (await cards(harness, root.id)).length === 1)
  await (await root.submit({ type: 'input', content: 'now' }, context)).wait(context)
  expect(await dividers(harness, root.id, 'backup.return')).toEqual([])
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-2' })
})

it('drops the record when someone picked another model meanwhile', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => limitedBy('faux-1', rateLimit),
    () => fauxAssistantMessage([fauxText('done')]),
    () => fauxAssistantMessage([fauxText('picked')]),
  ])
  const { root, harness } = await f.open()
  await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context)
  await until(async () => (await cards(harness, root.id)).length === 1)
  await harness.commit(async (tx) => {
    Object.assign(await tx.doc(Owner, root.id), { since: Date.now() - 31 * 60_000 })
    await f.models().setModel(tx, root.id, {
      type: 'pick',
      model: { provider: 'faux', modelId: 'faux-3' },
      thinkingLevel: 'off',
    })
  }, context)
  await (await root.submit({ type: 'input', content: 'picked' }, context)).wait(context)
  expect(await dividers(harness, root.id, 'backup.return')).toEqual([])
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-3' })
  expect(await state(harness, root.id)).toEqual({ by: 'user' })
  // #147838: a row kept showing the backup after a pick.
  expect(await harness.snapshot(Backups, ROOT_CONVERSATION_ID, context)).toEqual({})
})

it('does not return to the primary after the user picks the backup model itself', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => limitedBy('faux-1', rateLimit),
    () => fauxAssistantMessage([fauxText('backed up')]),
    () => fauxAssistantMessage([fauxText('picked backup')]),
  ])
  const { root, harness } = await f.open()
  await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context)
  await until(async () => (await cards(harness, root.id)).length === 1)
  await harness.commit(async (tx) => {
    Object.assign(await tx.doc(Owner, root.id), { since: Date.now() - 31 * 60_000 })
    await f.models().setModel(tx, root.id, {
      type: 'pick',
      model: { provider: 'faux', modelId: 'faux-2' },
      thinkingLevel: 'off',
    })
  }, context)
  await (await root.submit({ type: 'input', content: 'next' }, context)).wait(context)
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-2' })
  expect(await dividers(harness, root.id, 'backup.return')).toEqual([])
  expect(await state(harness, root.id)).toEqual({ by: 'user' })
})

it('switches once for a failure reported twice', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([() => fauxAssistantMessage([fauxText('hi')])])
  const { root, harness } = await f.open()
  await harness.commit(async (tx) => {
    ;(await tx.doc(AgentDoc, root.id)).model = { provider: 'faux', modelId: 'faux-1' }
  }, context)
  await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context)
  const [answer] = (await entries(harness, root.id)).slice(-1)
  // `Backup.fallBack` and the commit that recorded the same failed answer both report the one failure.
  const message = limitedBy('faux-1', rateLimit)
  expect(await f.backup().fallBack(root.id, message, answer.id)).toBe(true)
  expect(await f.backup().fallBack(root.id, message, answer.id)).toBe(true)
  expect(await cards(harness, root.id)).toHaveLength(1)
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-2' })
})

// #191380, #191455 and #194520 each tried the same exhausted backup in turn.
it('skips a backup another conversation found out of quota', async () => {
  const f = await fixture()
  f.prepared.faux!.setResponses([
    () => fauxAssistantMessage([fauxText('a')]),
    () => fauxAssistantMessage([fauxText('b')]),
  ])
  const { root, harness } = await f.open()
  const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const answer = async (conversation: { id: ConversationId }, modelId: string) => {
    await harness.commit(async (tx) => {
      ;(await tx.doc(AgentDoc, conversation.id)).model = { provider: 'faux', modelId }
    }, context)
    const handle = (await harness.conversation(conversation.id, context))!
    await (await handle.submit({ type: 'input', content: 'go' }, context)).wait(context)
    return (await entries(harness, conversation.id)).at(-1)!.id
  }
  const first = await answer(root, 'faux-2')
  const second = await answer(other, 'faux-1')
  expect(await f.backup().fallBack(root.id, limitedBy('faux-2', quota), first)).toBe(true)
  expect(await f.backup().fallBack(other.id, limitedBy('faux-1', rateLimit), second)).toBe(true)
  expect((await agent(harness, other.id)).model).toEqual({ provider: 'faux', modelId: 'faux-3' })
})

// #207552: a compaction's summary refused by every model failed the run, which could have waited on its primary.
it('waits on its primary when no model could write a summary, and keeps the backup out of credit', async () => {
  const f = await fixture()
  const { root, harness } = await f.open()
  const outOfCredit =
    '402: {"message":"the organization is out of credit, add more to continue","code":"insufficient_quota"}'
  await f.order().refused(
    root.id,
    [
      { model: ref('faux-1'), error: rateLimit },
      { model: ref('faux-2'), error: rateLimit },
      { model: ref('faux-3'), error: outOfCredit },
    ],
    1234,
  )
  expect(await state(harness, root.id)).toMatchObject({
    by: 'limit-wait',
    primary: ref('faux-1'),
    attempt: 1,
    tried: ['faux/faux-1'],
  })
  const [card] = await dividers(harness, root.id, 'backup.wait')
  expect(card.data).toMatchObject({
    from: 'faux/faux-1',
    primary: 'faux/faux-1',
    reason: 'rate limit',
    skipped: [
      { model: 'faux/faux-2', why: 'rate limit on the summary' },
      { model: 'faux/faux-3', why: 'out of credit' },
    ],
  })
  // The next summary skips it too.
  expect(
    (await harness.commit((tx) => f.order().order(tx, root.id), context)).map(
      (model) => model.modelId,
    ),
  ).toEqual(['faux-2'])
})

const ref = (modelId: string) => ({ provider: 'faux', modelId })
const SINCE = 1_000_000
const COOLDOWN_MS = 30 * 60_000
const primary: BackupState = { kind: 'primary' }
const onBackup: BackupState = {
  kind: 'backup',
  primary: ref('a'),
  thinking: 'high',
  to: ref('b'),
  since: SINCE,
  tried: ['faux/a'],
  reason: 'rate limit',
}
const waiting: BackupState = {
  kind: 'waiting',
  primary: ref('a'),
  thinking: 'high',
  since: SINCE,
  until: SINCE + 60_000,
  attempt: 1,
  tried: ['faux/a', 'faux/b'],
  reason: 'quota',
}
/** A try of `waiting` once its time came: asking the first backup, the wait kept. */
const trying: BackupState = {
  ...onBackup,
  since: SINCE + 60_000,
  wait: { since: SINCE, attempt: 1 },
}
const tooSmall = (model: ModelRef) => (model.modelId === 'b' ? 'too small' : undefined)
const none = () => 'no login'
const limit = (
  current: string,
  failed: string,
  from: BackupState,
  options: {
    now?: number
    skip?: (model: ModelRef) => string | undefined
    reset?: number
    candidates?: ModelRef[]
  } = {},
) =>
  backupStep(from, {
    type: 'limit',
    current: ref(current),
    currentThinking: 'medium',
    failed: `faux/${failed}`,
    reason: 'rate limit',
    candidates: options.candidates ?? [ref('b'), ref('c')],
    skip: options.skip ?? (() => undefined),
    ...(options.reset === undefined ? {} : { reset: options.reset }),
    jitter: 0,
    now: options.now ?? SINCE,
  })
const run = (now: number, login: boolean, from: BackupState) =>
  backupStep(from, { type: 'run', now, hasPrimaryLogin: () => login })

// The integration tests above cover the first switch, the chain, the cooldown and a pick at the next run; these rows
// are the outcomes they do not reach.
it.each([
  {
    row: 'a chained limit keeps the first thinking level, not the backup’s',
    from: onBackup,
    current: 'b',
    failed: 'b',
    kind: 'switched',
    after: { ...onBackup, to: ref('c'), tried: ['faux/a', 'faux/b'] },
  },
  {
    row: 'a limit of a model never tried, answered elsewhere, changes nothing',
    from: onBackup,
    current: 'b',
    failed: 'z',
    kind: 'none',
    after: onBackup,
  },
  {
    row: 'a backup too small for the conversation is passed over for the next',
    from: primary,
    current: 'a',
    failed: 'a',
    options: { skip: tooSmall },
    kind: 'switched',
    after: {
      kind: 'backup',
      primary: ref('a'),
      thinking: 'medium',
      to: ref('c'),
      since: SINCE,
      tried: ['faux/a'],
      reason: 'rate limit',
    },
  },
  {
    row: 'with no backup left it goes back to the primary and waits a minute',
    from: { ...onBackup, to: ref('c'), tried: ['faux/a', 'faux/b'] },
    current: 'c',
    failed: 'c',
    kind: 'waiting',
    after: {
      kind: 'waiting',
      primary: ref('a'),
      thinking: 'high',
      since: SINCE,
      until: SINCE + 60_000,
      attempt: 1,
      tried: ['faux/a', 'faux/b', 'faux/c'],
      reason: 'rate limit',
    },
  },
  {
    row: 'a limit on the primary that no backup can take waits for the primary’s reset',
    from: primary,
    current: 'a',
    failed: 'a',
    options: { skip: none, reset: SINCE + 3 * 3600_000 },
    kind: 'waiting',
    after: {
      kind: 'waiting',
      primary: ref('a'),
      thinking: 'medium',
      since: SINCE,
      until: SINCE + 3 * 3600_000,
      attempt: 1,
      tried: ['faux/a'],
      reason: 'rate limit',
    },
  },
  {
    row: 'a reset more than a day away starts no wait that could only time out',
    from: primary,
    current: 'a',
    failed: 'a',
    options: { skip: none, reset: SINCE + 25 * 3600_000 },
    kind: 'none',
    after: primary,
  },
  {
    row: 'without backup models nothing waits: the host pauses or the run fails, as before',
    from: primary,
    current: 'a',
    failed: 'a',
    options: { candidates: [] },
    kind: 'none',
    after: primary,
  },
  {
    row: 'the primary limited again before the wait is over changes nothing',
    from: waiting,
    current: 'a',
    failed: 'a',
    options: { now: SINCE + 59_999 },
    kind: 'held',
    after: waiting,
  },
  {
    row: 'a late answer of a backup the wait left is earlier',
    from: waiting,
    current: 'a',
    failed: 'b',
    kind: 'earlier',
    after: waiting,
  },
  {
    row: 'once the wait is over its try asks the backups again, as a try of the same wait',
    from: waiting,
    current: 'a',
    failed: 'a',
    options: { now: SINCE + 60_000 },
    kind: 'switched',
    after: trying,
  },
  // #251493: the try's backup limited too began the wait again at try 1, every 64 s all night.
  {
    row: 'a try whose backups are limited too goes on with the wait, twice as long, from the same start',
    from: { ...trying, to: ref('c'), tried: ['faux/a', 'faux/b'] },
    current: 'c',
    failed: 'c',
    options: { now: SINCE + 70_000 },
    kind: 'waiting',
    after: {
      ...waiting,
      until: SINCE + 70_000 + 120_000,
      attempt: 2,
      tried: ['faux/a', 'faux/b', 'faux/c'],
      reason: 'rate limit',
    },
  },
  {
    row: 'a try past a day gives up, also on a backup',
    from: {
      ...trying,
      to: ref('c'),
      tried: ['faux/a', 'faux/b'],
      wait: { since: SINCE, attempt: 40 },
    },
    current: 'c',
    failed: 'c',
    options: { now: SINCE + 23.75 * 3600_000 },
    kind: 'gave-up',
    after: primary,
  },
  {
    row: 'once the wait is over with still no backup it waits twice as long, from the same start',
    from: waiting,
    current: 'a',
    failed: 'a',
    options: { now: SINCE + 60_000, skip: none },
    kind: 'waiting',
    after: {
      ...waiting,
      until: SINCE + 60_000 + 120_000,
      attempt: 2,
      tried: ['faux/a'],
      reason: 'rate limit',
    },
  },
  {
    row: 'a wait that would outlast a day gives up and leaves the primary',
    from: { ...waiting, attempt: 40, until: SINCE + 23.75 * 3600_000 },
    current: 'a',
    failed: 'a',
    options: { now: SINCE + 23.75 * 3600_000, skip: none },
    kind: 'gave-up',
    after: primary,
  },
])('limit: $row', ({ from, current, failed, options, kind, after }) => {
  const { state: next, outcome } = limit(current, failed, structuredClone(from), options)
  expect(outcome.kind).toBe(kind)
  expect(next).toEqual(after)
})

// The way out of a wait: only an answer ends it; after one, the return to the primary and its limits start afresh.
it('ends a wait at a try’s answer, and a later return’s limits start a new chain', () => {
  const answered = backupStep(structuredClone(trying), { type: 'answered', model: 'faux/b' })
  expect(answered.outcome).toEqual({ kind: 'resumed', on: 'faux/b', since: SINCE })
  const back = run(SINCE + 60_000 + COOLDOWN_MS, true, answered.state)
  expect(back.outcome.kind).toBe('returned')
  const now = SINCE + 60_000 + COOLDOWN_MS
  const switched = limit('a', 'a', back.state, { now })
  expect(switched).toMatchObject({ outcome: { kind: 'switched' }, state: { tried: ['faux/a'] } })
  expect(switched.state).not.toHaveProperty('wait')
  const again = limit('b', 'b', switched.state, { now, skip: none })
  expect(again.state).toMatchObject({ kind: 'waiting', since: now, attempt: 1 })
})

it('says why each backup was skipped when it waits', () => {
  const { outcome } = limit('a', 'a', primary, { skip: tooSmall, candidates: [ref('b')] })
  expect(outcome).toMatchObject({
    kind: 'waiting',
    from: 'faux/a',
    skipped: [{ model: 'faux/b', why: 'too small' }],
  })
})

// Conversations waiting on one account's limit must not all try it again in the same second.
it('spreads the retries of conversations waiting on one limit', () => {
  const ids = Array.from({ length: 20 }, (_, index) => 100 + index)
  for (const [attempt, delay] of [
    [1, 60_000],
    [6, 30 * 60_000],
  ]) {
    const times = ids.map((id) => waitUntil(SINCE, attempt, jitterOf(id)) - SINCE)
    expect(new Set(times).size).toBe(ids.length)
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(delay)
      expect(time).toBeLessThan(delay * 1.25)
    }
  }
  const resets = ids.map((id) => waitUntil(SINCE, 1, jitterOf(id), SINCE + 3600_000))
  expect(new Set(resets).size).toBe(ids.length)
  for (const at of resets) expect(at - (SINCE + 3600_000)).toBeLessThan(60_000)
})

const HOUR = 3600_000
const seen = { until: SINCE + HOUR, at: SINCE, error: 'quota' }
const credit = { at: SINCE, error: 'out of credit' }
it.each<{ row: string; from: Exhausted; event: ExhaustedEvent; now?: number; after: Exhausted }>([
  {
    row: 'a quota counts until its provider’s reset',
    from: {},
    event: { type: 'quota', model: 'faux/a', reset: SINCE + 5 * HOUR, error: 'quota' },
    after: { 'faux/a': { until: SINCE + 5 * HOUR, at: SINCE, error: 'quota' } },
  },
  // #207552: GLM's 402 out of credit counted for an hour, and the next night's chain switched to it again.
  {
    row: 'a quota without a reset is out of credit, with no time',
    from: {},
    event: { type: 'quota', model: 'faux/a', error: 'out of credit' },
    after: { 'faux/a': credit },
  },
  {
    row: 'out of credit outlasts any time',
    from: { 'faux/a': credit },
    event: { type: 'answered', model: 'faux/b' },
    now: SINCE + 48 * HOUR,
    after: { 'faux/a': credit },
  },
  {
    row: 'an answer of the model, a pick of it after a top-up, clears it, and only it',
    from: { 'faux/a': credit, 'faux/b': seen },
    event: { type: 'answered', model: 'faux/a' },
    after: { 'faux/b': seen },
  },
  {
    row: 'a login clears its provider’s models',
    from: { 'faux/a': credit, 'other/a': seen },
    event: { type: 'login', provider: 'faux' },
    after: { 'other/a': seen },
  },
  {
    row: 'an expired one drops out at the next event',
    from: { 'faux/a': seen },
    event: { type: 'answered', model: 'faux/b' },
    now: SINCE + HOUR,
    after: {},
  },
])('exhausted: $row', ({ from, event, now, after }) => {
  expect(exhaustedStep(structuredClone(from), event, now ?? SINCE)).toEqual(after)
})

it('reads an exhausted model only until it resets', () => {
  expect(exhaustedUntil({ 'faux/a': seen }, 'faux/a', SINCE + HOUR - 1)).toBe(SINCE + HOUR)
  expect(exhaustedUntil({ 'faux/a': seen }, 'faux/a', SINCE + HOUR)).toBeUndefined()
  expect(exhaustedUntil({ 'faux/a': credit }, 'faux/a', SINCE + 48 * HOUR)).toBe(Infinity)
})

it.each([
  { row: 'the primary’s answer ends the wait', from: waiting, model: 'faux/a', kind: 'resumed' },
  { row: 'another model’s answer leaves it', from: waiting, model: 'faux/z', kind: 'none' },
  { row: 'on a backup an answer changes nothing', from: onBackup, model: 'faux/b', kind: 'none' },
  {
    row: 'a try’s backup answering ends the wait, and the conversation stays on it',
    from: trying,
    model: 'faux/b',
    kind: 'resumed',
    after: { ...onBackup, since: SINCE + 60_000 },
  },
  {
    row: 'a try’s backup keeps the wait until it answers',
    from: trying,
    model: 'faux/a',
    kind: 'none',
  },
])('answer: $row', ({ from, model, kind, after }) => {
  const { state: next, outcome } = backupStep(structuredClone(from), { type: 'answered', model })
  expect(outcome.kind).toBe(kind)
  expect(next).toEqual(after ?? (kind === 'resumed' ? primary : from))
})

it.each([
  {
    row: 'on the primary there is nothing to return from',
    from: primary,
    login: true,
    outcome: { kind: 'none' },
    after: primary,
  },
  {
    row: 'a wait already runs on its primary',
    from: waiting,
    login: true,
    outcome: { kind: 'none' },
    after: waiting,
  },
  {
    row: 'without a login for the primary the backup stays',
    from: onBackup,
    login: false,
    outcome: { kind: 'none' },
    after: onBackup,
  },
  {
    row: 'after the cooldown with a login it restores primary and thinking',
    from: onBackup,
    login: true,
    outcome: {
      kind: 'returned',
      primary: ref('a'),
      thinking: 'high',
      from: 'faux/b',
      to: 'faux/a',
    },
    after: primary,
  },
])('return: $row', ({ from, login, outcome, after }) => {
  const next = run(SINCE + COOLDOWN_MS, login, structuredClone(from))
  expect(next).toEqual({ state: after, outcome })
})

// A compaction's summary follows this order when the conversation's model is limited, without switching it.
it.each([
  {
    row: 'on the primary: the backups, in order',
    from: primary,
    current: 'a',
    now: SINCE,
    order: ['b', 'c'],
  },
  {
    row: 'on a backup within the cooldown: the untried backups only',
    from: onBackup,
    current: 'b',
    now: SINCE,
    order: ['c'],
  },
  {
    row: 'on a backup after the cooldown: the untried backups, then the primary',
    from: onBackup,
    current: 'b',
    now: SINCE + COOLDOWN_MS,
    order: ['c', 'a'],
  },
  {
    row: 'waiting on the primary: the backups, as on the primary',
    from: waiting,
    current: 'a',
    now: SINCE,
    order: ['b', 'c'],
  },
  // #189897: the summary went to backups too small to read the conversation.
  {
    row: 'never a backup too small for the conversation',
    from: primary,
    current: 'a',
    now: SINCE,
    skip: tooSmall,
    order: ['c'],
  },
])('order: $row', ({ from, current, now, order, skip }) => {
  const models = backupOrder(from, {
    current: ref(current),
    candidates: [ref('b'), ref('c')],
    skip: skip ?? (() => undefined),
    now,
  })
  expect(models.map((model) => model.modelId)).toEqual(order)
})
