import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Metadata } from '../../../../server/metadata.ts'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expect, it } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Messages } from '../../../messages/api.ts'
import { Automations } from '../../server.ts'
import { exitOf, pidOf, runConversation } from '../../state.ts'
import type { Automation } from '../../types.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, until } from '../../../../test/helpers.ts'
import { tracked, failed, fixture, writeRun, call } from './automations-scripts-fixture.ts'

it('starts a prompt run from script FIRE with its payload', async () => {
  const { app, folder } = await fixture()
  // An answer for every model call, however many come first. The watcher's turn, the prompt run, the caller's wake-up
  // and the summaries of each share the one scripted model, in no fixed order: with four answers queued, the run came
  // fifth on a busy CI shard, got "No more faux responses queued" and was recorded failed (`f669090`, `7629d0d`).
  const complete = () => {
    app.host.faux!.appendResponses([complete])
    return fauxAssistantMessage('Complete')
  }
  app.host.faux!.setResponses([complete])
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const a = (await app.extensions.invoke(
    'automations',
    'create',
    {
      name: 'Summary',
      ask: 'Watch',
      prompt: 'Summarize',
    },
    new AbortController().signal,
    caller.id,
  )) as Automation
  expect(a.subscribers).toEqual([])
  await app.extensions.invoke(
    'automations',
    'subscribe',
    { id: a.id, to: `#${caller.id}` },
    new AbortController().signal,
  )
  await writeRun(folder(a.id), 'echo FIRE hello')
  await call(app, 'resume', a.id)
  const record = async () => (await app.harness.snapshot(Automations, context))!.automations[a.id]
  await until(async () =>
    ['done', 'failed', 'aborted'].includes((await record()).runs[0]?.status ?? ''),
  )
  const run = (await record()).runs[0]
  expect(run.status).toBe('done')
  const child = (await app.harness.conversation(runConversation(run)!, context))!
  const entries = (await child.context(context)).entries.filter(
    (e) => e.conversationId === child.id,
  )
  const first = entries.find((e) => e.kind === 'pi.user')!.model![0]
  expect(first.content).toContain('Summarize')
  expect(first.content).toContain('Fired: hello')
  expect((await app.harness.snapshot(Metadata, child.id, context))?.label).toBe('automation')
  const fired = async () =>
    (await (await app.harness.conversation(caller.id, context))!.context(context)).entries.filter(
      (e) => e.conversationId === caller.id && e.kind === 'automations.fired',
    )
  await until(async () => (await fired()).length === 1)
  expect((await fired())[0].data).toEqual({ id: a.id, name: 'Summary', text: 'hello' })
  expect(await record()).toMatchObject({ fires: 1, enabled: false, script: { state: 'done' } })
})

it('delivers FIRE once, investigates exits only in the owning agent, recovers, and escalates through Messages', async () => {
  const { root, userHome, home, options, app: initial } = await fixture()
  let app = initial
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const invoke = (action: string, args: JsonValue = null) =>
    app.extensions.invoke('automations', action, args, new AbortController().signal, caller.id)
  const get = async (id: string) =>
    (await app.harness.snapshot(Automations, context))!.automations[id]
  const entries = async (id: number, kind: string) => {
    const conversation = (await app.harness.conversation(id as ConversationId, context))!
    return (await conversation.context(context)).entries.filter(
      (e) => e.conversationId === id && e.kind === kind,
    )
  }
  const script = async (id: string, text: string) => {
    const dir = join(userHome, '.ultimate/automations', basename(home), id)
    await mkdir(join(dir, 'state'), { recursive: true })
    await writeFile(join(dir, 'run'), `#!/bin/sh\n${text}\n`)
    await chmod(join(dir, 'run'), 0o700)
  }
  const first = (await invoke('create', {
    ask: 'Wake me when this finishes',
    name: 'CI',
  })) as Automation
  expect(first).toMatchObject({
    id: 'A1',
    subscribers: [caller.id],
    script: { state: 'writing', once: true },
  })
  await script(first.id, 'sleep 2; echo FIRE done')
  await invoke('resume', { id: first.id })
  await until(
    async () =>
      (await get(first.id)).script!.state === 'done' &&
      (await entries(caller.id, 'automations.fired')).length === 1,
  )
  expect((await entries(caller.id, 'automations.fired'))[0].data).toMatchObject({
    id: first.id,
    name: 'CI',
    text: 'done',
  })
  expect(await get(first.id)).toMatchObject({ enabled: false, fires: 1 })

  const second = (await invoke('create', {
    ask: 'Watch a failing process',
    name: 'Failure',
  })) as Automation
  await script(second.id, 'echo broken >&2; exit 3')
  await invoke('resume', { id: second.id })
  await until(
    async () => (await entries(second.script!.conversationId, 'automations.failed')).length === 1,
  )
  expect(await get(second.id)).toMatchObject({
    script: { state: 'investigating', exit: { exitCode: 3 } },
  })
  expect(await entries(caller.id, 'automations.failed')).toHaveLength(0)
  expect(
    JSON.stringify(await entries(second.script!.conversationId, 'automations.failed')),
  ).toContain('code 3')
  expect(await invoke('log', { id: second.id })).toEqual({ text: 'broken' })
  // Recovery itself never wakes subscribers; only the eventual FIRE does.
  await script(second.id, 'echo FIRE recovered')
  await invoke('resume', { id: second.id })
  await until(
    async () =>
      (await get(second.id)).script!.state === 'done' &&
      (await entries(caller.id, 'automations.fired')).length === 2,
  )
  expect(await entries(caller.id, 'automations.escalated')).toHaveLength(0)

  const third = (await invoke('create', { name: 'Watch', ask: 'This cannot work' })) as Automation
  await invoke('escalate', { id: third.id, reason: 'No access to the remote system' })
  await until(async () => (await entries(caller.id, 'automations.escalated')).length === 1)
  expect(await get(third.id)).toMatchObject({ enabled: false, script: { state: 'failed' } })
  const messages = (await app.harness.snapshot(Messages, 1 as ConversationId, context))!.messages
  expect(
    messages.filter(
      (m) =>
        m.from === third.script!.conversationId &&
        m.text.includes('No access to the remote system'),
    ),
  ).toHaveLength(1)
  await invoke('delete', { id: third.id })
  expect((await app.harness.snapshot(Automations, context))!.automations[third.id]).toBeUndefined()
  expect(
    await app.harness.conversation(third.script!.conversationId as ConversationId, context),
  ).toBeDefined()

  const recurring = (await invoke('create', {
    name: 'Watch',
    ask: 'Keep watching',
    once: false,
  })) as Automation
  await script(recurring.id, 'echo FIRE tick; exit 0')
  await failed(app, recurring.script!.conversationId)
  await invoke('resume', { id: recurring.id })
  await until(
    async () =>
      (await entries(recurring.script!.conversationId, 'automations.failed')).length === 1,
  )
  expect(await get(recurring.id)).toMatchObject({
    fires: 1,
    script: { state: 'investigating', exit: { exitCode: 0 } },
  })

  const restart = (await invoke('create', {
    name: 'Watch',
    ask: 'Survive a server reopen',
  })) as Automation
  await script(restart.id, 'echo stopping; sleep 60')
  const beforeRestart = (await invoke('resume', { id: restart.id })) as Automation
  const afterRestart = (await invoke('run', { id: restart.id })) as Automation
  expect(pidOf(afterRestart.script)).not.toBe(pidOf(beforeRestart.script))
  await invoke('pause', { id: restart.id })
  await until(async () => !!exitOf((await get(restart.id)).script!))
  expect(await get(restart.id)).toMatchObject({ enabled: false, script: { state: 'stopped' } })
  expect(await entries(restart.script!.conversationId, 'automations.failed')).toHaveLength(0)
  // A changed ask stops the running script and sends the watcher back to writing, as at creation.
  await invoke('resume', { id: restart.id })
  const watching = pidOf((await get(restart.id)).script)!
  const rewritten = (await invoke('update', {
    id: restart.id,
    ask: 'Survive a server reopen, then fire',
  })) as Automation
  expect(rewritten.script).toMatchObject({
    state: 'writing',
    ask: 'Survive a server reopen, then fire',
  })
  await until(() => {
    try {
      process.kill(watching, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  })
  await until(
    async () => (await entries(restart.script!.conversationId, 'automations.writing')).length === 2,
  )
  expect((await get(restart.id)).script!.state).toBe('writing')
  await script(
    restart.id,
    'if [ -e "$AUTOMATION_STATE/ready" ]; then echo FIRE resumed; else touch "$AUTOMATION_STATE/ready"; echo ready-for-reopen; sleep 60; fi',
  )
  await invoke('resume', { id: restart.id })
  await until(async () =>
    ((await invoke('log', { id: restart.id })) as { text: string }).text.includes(
      'ready-for-reopen',
    ),
  )
  await app.close()
  tracked.server = undefined
  app = await fauxServer(options)
  tracked.server = app
  await until(
    async () =>
      (await get(restart.id)).script!.state === 'done' &&
      (await entries(caller.id, 'automations.fired')).length === 4,
  )
  expect(
    (await entries(caller.id, 'automations.fired')).map((e) => (e.data as { text: string }).text),
  ).toEqual(['done', 'recovered', 'tick', 'resumed'])

  const disabled = (await invoke('create', {
    name: 'Watch',
    ask: 'Stop with the optional extension',
  })) as Automation
  await script(disabled.id, 'sleep 60')
  const running = (await invoke('resume', { id: disabled.id })) as Automation
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['automations'] } }),
  )
  await until(() => app.extensions.info().some((e) => e.name === 'automations' && !e.enabled))
  await until(() => {
    try {
      process.kill(pidOf(running.script)!, 0)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
  })
})

it('escalates on the third failure in a row, and when its watcher ends a turn without repairing', async () => {
  const { app, folder } = await fixture()
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  const invoke = (action: string, args: JsonValue) =>
    app.extensions.invoke('automations', action, args, new AbortController().signal, caller.id)
  const get = async (id: string) =>
    (await app.harness.snapshot(Automations, context))!.automations[id]
  const escalated = async () =>
    (await (await app.harness.conversation(caller.id, context))!.context(context)).entries.filter(
      (e) => e.conversationId === caller.id && e.kind === 'automations.escalated',
    )
  // Regression: a crash-looping script stayed `investigating` as long as its watcher kept resuming it.
  const crash = (await invoke('create', { name: 'Crash', ask: 'Crash loop' })) as Automation
  await writeRun(folder(crash.id), 'exit 1')
  for (const failures of [1, 2]) {
    await invoke('resume', { id: crash.id })
    await until(async () => (await get(crash.id)).script!.failures === failures)
    expect((await get(crash.id)).script!.state).toBe('investigating')
  }
  await invoke('resume', { id: crash.id })
  await until(async () => (await escalated()).length === 1)
  expect(await get(crash.id)).toMatchObject({
    enabled: false,
    script: {
      state: 'failed',
      failures: 3,
      error: 'Failed 3 times in a row: Process exited with code 1',
    },
  })

  // Regression: a watcher that answered without resuming or escalating left its script `writing` for good.
  const answer = () => {
    app.host.faux!.appendResponses([answer])
    return fauxAssistantMessage('I could not find the CI API.')
  }
  app.host.faux!.setResponses([answer])
  const stalled = (await invoke('create', { name: 'Stalled', ask: 'Watch CI' })) as Automation
  await until(async () => (await escalated()).length === 2)
  expect(await get(stalled.id)).toMatchObject({
    enabled: false,
    script: {
      state: 'failed',
      error: 'The watcher stopped while the script was writing: I could not find the CI API.',
    },
  })
})
