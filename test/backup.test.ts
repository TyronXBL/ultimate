import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AgentDoc, ROOT_CONVERSATION_ID, configure } from '@earendil-works/pi-durable'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import backupExtension, { docs } from '../extensions/backup/server.ts'
import { BackupApi } from '../extensions/backup/api.ts'
import pauseExtension from '../extensions/pause/server.ts'
import { PauseApi } from '../extensions/pause/api.ts'
import { Pin } from '../extensions/models/api.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { apis, removeTemps, temp, until } from './helpers.ts'

const [State] = docs

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
const state = (harness: Harness, id: ConversationId) => harness.snapshot(State, id, context)

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
    primary: { provider: 'faux', modelId: 'faux-1' },
    to: { provider: 'faux', modelId: 'faux-2' },
    tried: ['faux/faux-1'],
  })
  expect(record!.since).toBeGreaterThan(Date.now() - 60_000)
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
  expect(await state(harness, root.id)).toEqual({})
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
  // The cooldown passed while the conversation was idle on the backup.
  await harness.commit(async (tx) => {
    ;(await tx.doc(State, root.id)).since = Date.now() - 31 * 60_000
  }, context)

  expect(
    (await (await root.submit({ type: 'input', content: 'next' }, context)).wait(context)).status,
  ).toBe('done')
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  const [divider] = await dividers(harness, root.id, 'backup.return')
  expect(divider.data).toEqual({ from: 'faux/faux-2', to: 'faux/faux-1' })
  expect(await state(harness, root.id)).toEqual({})
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
    await configure(tx, root.id, { model: { provider: 'faux', modelId: 'faux-3' } })
    ;(await tx.doc(State, root.id)).since = Date.now() - 31 * 60_000
    await Promise.resolve()
  }, context)
  await (await root.submit({ type: 'input', content: 'picked' }, context)).wait(context)
  expect(await dividers(harness, root.id, 'backup.return')).toEqual([])
  expect((await agent(harness, root.id)).model).toEqual({ provider: 'faux', modelId: 'faux-3' })
  expect(await state(harness, root.id)).toEqual({})
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
