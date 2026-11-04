import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Automations } from '../../extensions/automations/server.ts'
import { Done } from '../../extensions/automations/refs.ts'
import type { Automation, AutomationListItem } from '../../extensions/automations/types.ts'
import { context } from '../../server/harness.ts'
import { eventHost, until } from '../helpers.ts'
import { tracked, fixture, create, writeRun, call } from './automations-scripts-fixture.ts'

/** A recurring project automation committed in `root`'s `.ultimate/automations/<slug>/`. */
async function committed(root: string, slug: string, script: string) {
  const dir = join(root, '.ultimate/automations', slug)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'automation.json'),
    JSON.stringify({ name: 'Ship PRs', ask: 'Poll ship/* PRs', once: false }),
  )
  await writeFile(join(dir, 'run'), `#!/bin/sh\n${script}\n`)
  await chmod(join(dir, 'run'), 0o700)
}
/** Project records only: dream can independently register its built-in event automation. */
async function list(app: NonNullable<typeof tracked.server>) {
  const automations = (await app.extensions.invoke(
    'automations',
    'list',
    null,
    new AbortController().signal,
  )) as Automation[]
  return automations.filter((a) => a.scope === 'project')
}

it('stops a recurring script that prints DONE and exits 0 without waking anyone; start resumes it with its state', async () => {
  const { app, folder } = await fixture()
  const sub = (await app.extensions.invoke(
    'automations',
    'create',
    { name: 'Watch', ask: 'Poll until merged', once: false },
    new AbortController().signal,
    (await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id,
  )) as Automation
  const get = async () => (await app.harness.snapshot(Automations, context))!.automations[sub.id]
  const inputs = async (id: number) =>
    (
      await (await app.harness.conversation(id as ConversationId, context))!.context(context)
    ).entries
      .filter((e) => e.conversationId === id && e.kind.startsWith('automations.'))
      .map((e) => e.kind)
  const done = () => eventHost(() => app.harness, 'test').eventLog.recent({ events: [Done] })
  // Each run counts itself in its state folder, fires the count and stops itself.
  await writeRun(
    folder(sub.id),
    'n=$(($(cat "$AUTOMATION_STATE/n" 2>/dev/null || echo 0) + 1)); echo $n > "$AUTOMATION_STATE/n"; echo FIRE $n; echo DONE all merged',
  )
  await call(app, 'resume', sub.id)
  await until(async () => !!(await get()).script!.exitedAt)
  expect(await get()).toMatchObject({
    enabled: false,
    fires: 1,
    script: { state: 'stopped', exitCode: 0 },
  })
  expect((await get()).script!.error).toBeUndefined()
  expect((await done()).map((e) => e.data)).toEqual([{ id: sub.id, text: 'all merged' }])
  await call(app, 'resume', sub.id)
  await until(async () => (await get()).fires === 2 && (await get()).script!.state === 'stopped')
  expect(await readFile(join(folder(sub.id), 'state/n'), 'utf8')).toBe('2\n')
  const subscriber = sub.subscribers[0] as number
  await until(async () => (await inputs(subscriber)).length === 2)
  expect(await inputs(subscriber)).toEqual(['automations.fired', 'automations.fired'])
  // The owning agent got only its writing brief: no failure input.
  expect(await inputs(sub.script!.conversationId)).toEqual(['automations.writing'])

  // DONE followed by a non-zero exit stays a failure.
  await writeRun(folder(sub.id), 'echo DONE; exit 2')
  await call(app, 'resume', sub.id)
  await until(async () => (await get()).script!.state === 'investigating')
  expect(await get()).toMatchObject({ enabled: true, script: { exitCode: 2 } })
  await until(async () => (await inputs(sub.script!.conversationId)).includes('automations.failed'))
  expect(await done()).toHaveLength(2)

  // A one-shot cannot DONE: exiting without a FIRE still fails, so its subscribers are not left waiting.
  const once = await create(app)
  await writeRun(folder(once.id), 'echo DONE')
  await call(app, 'resume', once.id)
  await until(
    async () =>
      (await app.harness.snapshot(Automations, context))!.automations[once.id].script!.state ===
      'investigating',
  )
  expect(await done()).toHaveLength(2)
})

it('keeps listing and supervising scripts after a reload bumps the ledger version', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  const get = async () =>
    (
      (await app.extensions.invoke(
        'automations',
        'list',
        null,
        new AbortController().signal,
      )) as AutomationListItem[]
    ).find((a) => a.id === sub.id)!
  await writeRun(folder(sub.id), 'sleep 60')
  const before = (await call(app, 'resume', sub.id)) as Automation
  // ultimateRoot is an isolated source copy; never mutate the working checkout here.
  const file = join(app.host.ultimateRoot, 'extensions/automations/server.ts')
  const source = await readFile(file, 'utf8')
  const loaded = () => app.extensions.info().find((e) => e.name === 'automations')!.server!.loadedAt
  const previous = loaded()
  const bumped = source.replace('  version: 3,\n  scope: ', '  version: 4,\n  scope: ')
  expect(bumped).not.toBe(source)
  // One reload, from the emit below: the real watcher's event for the same write could arrive after it and reload
  // again while the test's resume is launching, which fails that launch as the supervisor closes.
  app.vite.watcher.unwatch(file)
  await writeFile(file, bumped)
  app.vite.watcher.emit('change', file)
  await until(() => loaded() !== previous)
  // A reload restarts running scripts on the new code, as a core swap does.
  await until(async () => {
    const now = await get()
    return now.alive && now.script!.pid !== before.script!.pid
  })
  // The new token migrates the ledger to version 4 on its next write; the supervisor must use it too.
  await call(app, 'pause', sub.id)
  await until(async () => !!(await get()).script!.exitedAt)
  expect(await get()).toMatchObject({ enabled: false, script: { state: 'stopped' } })
  await writeRun(folder(sub.id), 'echo FIRE after')
  await call(app, 'resume', sub.id)
  await until(async () => (await get()).fires === 1)
})

it('discovers a committed project automation by slug only in a chosen project, and starts, stops and DONEs it there', async () => {
  // Not chosen as local: the committed folder is ignored and cannot be addressed.
  const untrusted = await fixture(false)
  await committed(untrusted.root, 'prs', 'echo FIRE never')
  expect(await list(untrusted.app)).toEqual([])
  await expect(call(untrusted.app, 'resume', 'prs')).rejects.toThrow('Unknown automation: prs')
  await untrusted.app.close()
  tracked.server = undefined

  const { root, app, folder } = await fixture()
  // It runs in the project checkout and keeps state in the machine-local folder.
  await committed(
    root,
    'prs',
    'pwd > "$AUTOMATION_STATE/cwd"; echo 1 > "$AUTOMATION_STATE/n"; echo FIRE 1; sleep 60',
  )
  const [found] = await list(app)
  expect(found).toMatchObject({
    id: 'prs',
    scope: 'project',
    name: 'Ship PRs',
    enabled: false,
    // Regression: discovered project scripts woke nobody. The manifest's `to` defaults to @ultimate.
    subscribers: ['@ultimate'],
    script: { once: false, state: 'stopped', to: '@ultimate' },
  })
  // Discovery never starts it; its agent conversation exists, idle.
  expect(found.script?.pid).toBeUndefined()
  expect(
    await app.harness.conversation(found.script?.conversationId as ConversationId, context),
  ).toBeDefined()
  expect((await list(app)).map((s) => s.script!.conversationId)).toEqual([
    found.script?.conversationId,
  ])

  const get = async () => (await app.harness.snapshot(Automations, context))!.automations.prs
  const started = (await call(app, 'resume', 'prs')) as Automation
  expect(started).toMatchObject({ enabled: true, script: { state: 'running' } })
  await until(async () => (await get()).fires === 1)
  expect(await readFile(join(folder('prs'), 'state/cwd'), 'utf8')).toBe(`${root}\n`)
  expect(await readFile(join(folder('prs'), 'output.log'), 'utf8')).toContain('FIRE 1')
  await expect(readFile(join(root, '.ultimate/automations/prs/output.log'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await call(app, 'pause', 'prs')
  await until(async () => !!(await get()).script!.exitedAt)
  expect(await get()).toMatchObject({ enabled: false, script: { state: 'stopped' } })
  await expect(readFile(join(folder('prs'), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })

  // An edited run is picked up on the next start, with its state kept; DONE then exit 0 stops it cleanly.
  await committed(
    root,
    'prs',
    'n=$(($(cat "$AUTOMATION_STATE/n") + 1)); echo $n > "$AUTOMATION_STATE/n"; echo FIRE $n; echo DONE nothing left',
  )
  await call(app, 'resume', 'prs')
  await until(async () => (await get()).fires === 2 && (await get()).script!.state === 'stopped')
  expect(await get()).toMatchObject({ enabled: false, script: { exitCode: 0 } })
  expect((await get()).script!.error).toBeUndefined()
  const done = await eventHost(() => app.harness, 'test').eventLog.recent({ events: [Done] })
  expect(done.map((e) => e.data)).toEqual([{ id: 'prs', text: 'nothing left' }])

  // A removed folder forgets the record.
  await rm(join(root, '.ultimate/automations/prs'), { recursive: true })
  expect(await list(app)).toEqual([])
})

it('creates a project automation in the checkout with a committed manifest', async () => {
  const { root, app } = await fixture()
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  // A create that fails before it has an agent leaves the slug free for the retry.
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      { ask: 'Poll ship PRs', name: 'Ship PRs', scope: 'project' },
      new AbortController().signal,
      999_999,
    ),
  ).rejects.toThrow('Unknown caller #999999')
  const sub = (await app.extensions.invoke(
    'automations',
    'create',
    {
      ask: 'Poll ship PRs',
      name: 'Ship PRs',
      once: false,
      scope: 'project',
      secrets: ['GH_TOKEN'],
    },
    new AbortController().signal,
    caller.id,
  )) as Automation
  expect(sub).toMatchObject({
    id: 'ship-prs',
    scope: 'project',
    subscribers: ['@ultimate', caller.id],
    script: { state: 'writing' },
  })
  expect(
    JSON.parse(
      await readFile(join(root, '.ultimate/automations/ship-prs/automation.json'), 'utf8'),
    ),
  ).toEqual({ name: 'Ship PRs', ask: 'Poll ship PRs', once: false, secrets: ['GH_TOKEN'] })
  // Discovery keeps the created record and its agent.
  const listed = await list(app)
  expect(listed).toMatchObject([
    { id: 'ship-prs', script: { conversationId: sub.script!.conversationId, state: 'writing' } },
  ])
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      { ask: 'Again', name: 'Ship PRs', scope: 'project' },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('Automation ship-prs already exists')
  // The identical create (as a replay would send it) cannot reset a record that has been used either.
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      {
        ask: 'Poll ship PRs',
        name: 'Ship PRs',
        once: false,
        scope: 'project',
        secrets: ['GH_TOKEN'],
      },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('Automation ship-prs already exists')
  expect((await list(app))[0]).toMatchObject({
    subscribers: ['@ultimate', caller.id],
    script: { state: 'writing' },
  })

  await app.extensions.invoke(
    'automations',
    'update',
    {
      id: sub.id,
      name: 'Updated',
      ask: 'Watch merged PRs',
      once: true,
      secrets: [],
      prompt: 'Summarize',
    },
    new AbortController().signal,
  )
  expect(
    JSON.parse(
      await readFile(join(root, '.ultimate/automations/ship-prs/automation.json'), 'utf8'),
    ),
  ).toEqual({
    name: 'Updated',
    ask: 'Watch merged PRs',
    once: true,
  })
  expect((await list(app)).find((a) => a.id === sub.id)).toMatchObject({
    name: 'Updated',
    prompt: 'Summarize',
    // Regression: discovery applied the new ask first, so the watcher was never sent back to writing.
    script: { ask: 'Watch merged PRs', once: true, state: 'writing' },
  })
  const watcherInputs = async () =>
    (
      await (await app.harness.conversation(
        sub.script!.conversationId as ConversationId,
        context,
      ))!.context(context)
    ).entries.filter((e) => e.kind === 'automations.writing')
  await until(async () => (await watcherInputs()).length === 2)

  // Two creates racing for one slug: exactly one publishes and takes the record; the other is refused.
  const racing = await Promise.allSettled(
    ['Poll A', 'Poll B'].map((ask) =>
      app.extensions.invoke(
        'automations',
        'create',
        { ask, name: 'Race', scope: 'project' },
        new AbortController().signal,
        caller.id,
      ),
    ),
  )
  expect(racing.map((r) => r.status).toSorted()).toEqual(['fulfilled', 'rejected'])
  const won = (racing.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Automation>)
    .value
  expect(
    JSON.parse(await readFile(join(root, '.ultimate/automations/race/automation.json'), 'utf8'))
      .ask,
  ).toBe(won.script!.ask)

  // A discovered, unused record with the same manifest is taken by the create, with its agent: a create that crashed
  // after publishing its manifest replays to it. Inherited object keys are no slugs.
  await committed(root, 'ship-prs-2', 'true')
  const discovered = (await list(app)).find((s) => s.id === 'ship-prs-2')!
  const adopted = (await app.extensions.invoke(
    'automations',
    'create',
    {
      ask: 'Poll ship/* PRs',
      name: 'Ship PRs',
      once: false,
      scope: 'project',
      slug: 'ship-prs-2',
    },
    new AbortController().signal,
    caller.id,
  )) as Automation
  expect(adopted).toMatchObject({
    subscribers: ['@ultimate', caller.id],
    script: { conversationId: discovered.script?.conversationId, state: 'writing' },
  })
  // A manifest naming another standing agent wakes it instead, and the record follows an edit.
  await writeFile(
    join(root, '.ultimate/automations/ship-prs-2/automation.json'),
    JSON.stringify({ name: 'Ship PRs', ask: 'Poll ship/* PRs', once: false, to: '@reviewer' }),
  )
  expect((await list(app)).find((s) => s.id === 'ship-prs-2')).toMatchObject({
    subscribers: [caller.id, '@reviewer'],
    script: { to: '@reviewer' },
  })
  await expect(
    app.extensions.invoke(
      'automations',
      'create',
      { name: 'Watch', ask: 'x', scope: 'project', slug: 'constructor' },
      new AbortController().signal,
      caller.id,
    ),
  ).rejects.toThrow('not be an object key')
})
