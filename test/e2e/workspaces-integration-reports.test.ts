import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../server/harness.ts'
import { Metadata } from '../../server/metadata.ts'
import { UiState } from '../../server/ui-state.ts'
import type { ActionContext } from '../../server/actions.ts'
import workspaceExtension from '../../extensions/workspaces/server.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../lib/git.ts'
import { createLander } from '../../extensions/workspaces/lander.ts'
import { SubmissionFailed, SubmissionLanded } from '../../extensions/workspaces/api.ts'
import lineage, { leaveNote } from '../../extensions/lineage/server.ts'
import { LineageApi, Roots } from '../../extensions/lineage/api.ts'
import {
  actions as conversationActions,
  concludeIn,
  subject,
} from '../../extensions/conversations/server.ts'
import { ConversationsApi } from '../../extensions/conversations/api.ts'
import { Summaries } from '../../extensions/conversations/summary.ts'
import { Messages, MessagesApi } from '../../extensions/messages/api.ts'
import { Started } from '../../extensions/messages/addresses.ts'
import { until } from '../helpers.ts'
import {
  conversations,
  fixture,
  commit,
  submitted,
  landerLog,
  rootNotes,
  messageLog,
  lander,
} from './workspaces-integration-fixture.ts'

/** Wait until every reactor has handled every event so far. */
const reacted = (f: Awaited<ReturnType<typeof fixture>>) =>
  until(async () => (await f.host.eventLog.reactors()).every((reactor) => reactor.lag === 0))

const concludedIds = async (f: Awaited<ReturnType<typeof fixture>>) =>
  ((await f.opened.harness.snapshot(UiState, ROOT_CONVERSATION_ID, context))?.[
    'ext.conversations.concluded'
  ] ?? []) as number[]
/** A lander fixture with the real message branches provider, conclude and release. */
async function concluding() {
  const f = await lander({}, undefined, true)
  f.host.implement(
    ConversationsApi,
    conversations(f.host, {
      concluded: async () => new Set<ConversationId>(),
      subject: async () => ({}),
      concludeIn: (tx, ids) => concludeIn(f.host, tx, ids),
    }),
  )
  f.prepared.registry.install(lineage(f.host))
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'concluded.txt')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Started, id)).by = ROOT_CONVERSATION_ID
  }, context)
  return { f, id }
}

it.concurrent('emits one landed event and notes the root once, across a replayed report and a reopen', async () => {
  const f = await lander({})
  f.prepared.registry.install(lineage(f.host))
  const task = createLander(f.host, Workspaces, (_source, operation) => operation(), {
    starter: async () => undefined,
    working: async () => false,
    conclude: async () => {},
    release: async () => [],
  })
  const report = task.definition.phases.report
  let replays = 0
  f.prepared.registry.install(
    defineExtension({
      ...workspaceExtension(f.host),
      tasks: [
        ...(workspaceExtension(f.host).tasks ?? []).filter(
          (item) => item.definition.name !== task.definition.name,
        ),
        {
          definition: {
            ...task.definition,
            phases: {
              ...task.definition.phases,
              report: async (...args: Parameters<typeof report>) => {
                const [current, runtime, ctx] = args
                // Simulate resuming the persisted report checkpoint after its deliveries, before advancing.
                await report(current, { ...runtime, commit: async () => undefined }, ctx)
                replays++
                await report(current, runtime, ctx)
              },
            },
          },
        },
      ],
    }),
  )
  // The submitter is a branch of the root, so its landing is the root's tally.
  const at = await f.opened.harness.commit(
    async (tx) =>
      (await tx.appendEntry(f.opened.root.id, { kind: 'test.branch-point', data: {} })).id,
    context,
  )
  const { id } = await f.opened.root.fork(at, { ownership: { kind: 'ownerless' } }, context)
  const submittedAt = await f.opened.harness.commit(
    async (tx) => (await tx.appendEntry(id, { kind: 'test.submit-point', data: {} })).id,
    context,
  )
  await f.opened.harness.commit((tx) => f.service.create(tx, id, f.projectRoot), context)
  await f.service.ready(id, context)
  const sha = await commit((await f.service.get(id, context))!.path, 'landed.txt')
  f.host.implement(
    ConversationsApi,
    conversations(f.host, {
      concluded: async () => new Set<ConversationId>(),
      subject: (conversation, ctx) => subject(f.host, conversation, ctx),
    }),
  )
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).title = 'Write the feature'
    Object.assign(await tx.doc(Summaries, id), {
      summary: 'Adds the landed file.',
      feature: 'Landing',
    })
  }, context)
  const { id: submission } = await f.service.submit(
    id,
    'Added a landing file instead of changing the UI.',
    context,
  )
  // A retitle after submitting does not rename what lands.
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).title = 'Renamed later'
  }, context)
  expect(await submitted(f, id)).toHaveLength(1)
  const featureOf = {
    title: 'Write the feature',
    summary: 'Adds the landed file.',
    feature: 'Landing',
  }
  expect(
    (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.results[
      submission
    ],
  ).toMatchObject({
    conversationId: id,
    subject: featureOf,
    at: submittedAt,
    divergence: 'Added a landing file instead of changing the UI.',
  })
  expect(
    (await landerLog(f)).log.filter((line) => line.step === 'started' || line.outcome),
  ).toEqual([
    expect.objectContaining({ subject: featureOf }),
    expect.objectContaining({ subject: featureOf }),
  ])
  expect(replays).toBe(1)
  const landings = await f.host.eventLog.recent({ events: [SubmissionLanded] })
  expect(landings.map((event) => event.data)).toEqual([
    {
      submission,
      conversationId: id,
      at: submittedAt,
      sha,
      base: expect.any(String),
      target: 'main',
      lander: (await landerLog(f)).id,
      divergence: 'Added a landing file instead of changing the UI.',
      title: 'Write the feature',
      summary: 'Adds the landed file.',
      feature: 'Landing',
      commits: [{ sha: sha.slice(0, 7), subject: 'landed.txt' }],
      commitCount: 1,
      paths: ['landed.txt'],
      unchecked: { reason: 'none' },
    },
  ])
  // Lineage's reactor notes the root; it is no tally, so a delivery task writes the note.
  await reacted(f)
  await until(async () => (await rootNotes(f)).length > 0)
  // A rerun of that delivery reuses the same write request.
  await leaveNote(f.host, 'root', 'duplicate delivery', {
    source: 'lander',
    from: id,
    requestId: `lander-root:${submission}`,
  })
  const notes = await rootNotes(f)
  expect(notes).toHaveLength(1)
  expect(notes[0].data).toMatchObject({
    source: 'lander',
    from: id,
    at: submittedAt,
    divergence: 'Added a landing file instead of changing the UI.',
    sha,
    target: 'main',
    title: 'Write the feature',
    summary: 'Adds the landed file.',
    feature: 'Landing',
    commits: [{ sha: sha.slice(0, 7), subject: 'landed.txt' }],
    paths: ['landed.txt'],
    unchecked: { reason: 'none' },
  })
  expect((notes[0].data as { text: string }).text).toContain(
    `Landed ${sha.slice(0, 7)} on main from #${id}/${submittedAt} Write the feature (Landing):\nDiverged: Added a landing file instead of changing the UI.`,
  )
  await f.reopen()
  await reacted(f)
  await (await f.opened.harness.conversation(ROOT_CONVERSATION_ID, context))!.waitForIdle(context)
  expect(await rootNotes(f)).toHaveLength(1)
  expect(await f.host.eventLog.recent({ events: [SubmissionLanded] })).toHaveLength(1)
})

it.concurrent('does not note the root about its own submission', async () => {
  const f = await lander({})
  f.prepared.registry.install(lineage(f.host))
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(id)
  }, context)
  await f.service.submit(id, 'None', context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  await reacted(f)
  const view = await (await f.opened.harness.conversation(id, context))!.context(context)
  expect(view.entries.filter((entry) => entry.kind === 'lineage.note')).toHaveLength(0)
  expect(await rootNotes(f)).toHaveLength(0)
})

it.concurrent('notes the root of the submitter’s tree and skips a conversation outside any tree', async () => {
  const f = await lander({})
  f.prepared.registry.install(lineage(f.host))
  // A second root, and a branch of it that lands; an unrooted conversation lands too.
  const other = await f.opened.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const at = await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
    return (await tx.appendEntry(other.id, { kind: 'test.branch-point', data: {} })).id
  }, context)
  const branch = await other.fork(at, { ownership: { kind: 'ownerless' } }, context)
  await f.opened.harness.commit((tx) => f.service.create(tx, branch.id, f.projectRoot), context)
  await f.service.ready(branch.id, context)
  await commit((await f.service.get(branch.id, context))!.path, 'branch.txt')
  await f.service.submit(branch.id, 'None', context)
  expect((await submitted(f, branch.id))[0]).toContain('landed as')
  const unrooted = await f.create()
  await f.service.ready(unrooted, context)
  await commit((await f.service.get(unrooted, context))!.path, 'unrooted.txt')
  await f.service.submit(unrooted, 'None', context)
  expect((await submitted(f, unrooted))[0]).toContain('landed as')
  await reacted(f)
  const notes = async (id: ConversationId) => {
    const view = await (await f.opened.harness.conversation(id, context))!.context(context)
    return view.entries.filter((entry) => entry.kind === 'lineage.note')
  }
  await until(async () => (await notes(other.id)).length > 0)
  expect((await notes(other.id)).map((note) => (note.data as { from: number }).from)).toEqual([
    branch.id,
  ])
  expect(await rootNotes(f)).toHaveLength(0)
})
it.concurrent('lets an ownerless history fork submit its own workspace', async () => {
  const f = await lander({ checks: ['test -f base.txt'] })
  const entry = await f.opened.harness.commit(
    (tx) => tx.appendEntry(f.opened.root.id, { kind: 'test.branch-point', data: {} }),
    context,
  )
  const fork = await f.opened.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  await f.opened.harness.commit((tx) => f.service.create(tx, fork.id, f.projectRoot), context)
  await f.service.ready(fork.id, context)
  await commit((await f.service.get(fork.id, context))!.path, 'branch.txt')
  const result = await f.call(fork.id, 'workspace', { action: 'submit', divergence: 'None' })
  expect(JSON.stringify(result)).toContain('position')
  const [report] = await submitted(f, fork.id)
  expect(report).toContain('landed as')
  expect(await readFile(join(f.projectRoot, 'branch.txt'), 'utf8')).toBe('branch.txt')
})
it.concurrent('lands and reports a submission without a lineage provider', async () => {
  const f = await lander({ checks: ['test -f base.txt'] })
  expect(f.host.want(LineageApi)).toBeUndefined()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path, 'no-lineage.txt')
  await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(await readFile(join(f.projectRoot, 'no-lineage.txt'), 'utf8')).toBe('no-lineage.txt')
  expect(await rootNotes(f)).toHaveLength(0)
})
it.concurrent('records neither the submission nor the landing report in the message log', async () => {
  const f = await lander({}, undefined, true)
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path, 'first.txt')
  await commit(workspace.path, 'second.txt')
  const result = await f.service.submit(id, 'None', context)
  await submitted(f, id)
  expect(await messageLog(f)).toEqual([])
  const report = await f.opened.harness.commit(
    (tx) => tx.submissionByRequest(id, `lander:${result.id}`),
    context,
  )
  expect(report!.entry).toBeDefined()
})

it.concurrent('notes a clean landing without a branch run, concludes and releases it, and wakes its starter once across replay', async () => {
  const { f, id } = await concluding()
  const workspace = (await f.service.get(id, context))!
  const task = f.service.Lander
  const report = task.definition.phases.report
  let replays = 0
  f.prepared.registry.install(
    defineExtension({
      ...workspaceExtension(f.host),
      tasks: [
        ...(workspaceExtension(f.host).tasks ?? []).filter(
          (item) => item.definition.name !== task.definition.name,
        ),
        {
          definition: {
            ...task.definition,
            phases: {
              ...task.definition.phases,
              report: async (...args: Parameters<typeof report>) => {
                const [current, runtime, ctx] = args
                // Commit conclusion and deliver the starter's input, but replay the report checkpoint.
                await report(
                  current,
                  {
                    ...runtime,
                    commit: (change, caller) =>
                      runtime.commit(async (...values) => {
                        await change(...values)
                        return undefined
                      }, caller),
                  },
                  ctx,
                )
                replays++
                await report(current, runtime, ctx)
              },
            },
          },
        },
      ],
    }),
  )
  const { id: submission } = await f.service.submit(id, 'None', context)
  expect(await submitted(f, id)).toHaveLength(1)
  await f.opened.root.waitForIdle(context)
  expect(replays).toBe(1)
  expect(await concludedIds(f)).toContain(id)
  expect((await f.service.get(id, context))!.state).toBe('removed')
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toBe('')
  const checkReports = async () => {
    const requests = await f.opened.harness.commit(
      async (tx) => ({
        branch: await tx.submissionByRequest(id, `lander:${submission}`),
        starter: await tx.submissionByRequest(ROOT_CONVERSATION_ID, `lander:${submission}`),
      }),
      context,
    )
    expect(requests.branch).toMatchObject({ type: 'write' })
    expect(requests.starter).toMatchObject({ type: 'input' })
    const branch = (await f.opened.harness.conversation(id, context))!
    const entries = (await branch.context(context)).entries
    expect(entries.filter((entry) => entry.kind === 'pi.assistant')).toHaveLength(0)
    expect(entries.filter((entry) => entry.kind === 'workspaces.lander-report')).toHaveLength(1)
    const reports = (await f.opened.root.context(context)).entries.filter(
      (entry) => entry.kind === 'workspaces.lander-report',
    )
    expect(reports).toHaveLength(1)
    expect(JSON.stringify(reports[0].model)).toContain(`#${id} is concluded.`)
  }
  await checkReports()
  await f.reopen()
  await checkReports()
})
it.concurrent('keeps a landed branch and its checkout while a reply is under way and tells its starter', async () => {
  const { f, id } = await concluding()
  await f.opened.harness.commit(async (tx) => {
    const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
    log.messages.push({
      id: log.next++,
      from: id,
      to: ROOT_CONVERSATION_ID,
      text: 'Review this?',
      at: 1,
      reply: true,
      state: 'sent',
    })
  }, context)
  await f.service.submit(id, 'None', context)
  await submitted(f, id)
  await f.opened.root.waitForIdle(context)
  expect(await concludedIds(f)).not.toContain(id)
  const workspace = (await f.service.get(id, context))!
  expect(workspace.state).toBe('ready')
  await access(workspace.path)
  const reports = (await f.opened.root.context(context)).entries.filter(
    (entry) => entry.kind === 'workspaces.lander-report',
  )
  expect(reports).toHaveLength(1)
  expect(JSON.stringify(reports[0].model)).toContain(
    `#${id} still has work under way; it reports when it stops.`,
  )
})
it.concurrent('wakes only the submitter on a failed landing and leaves it open', async () => {
  const { f, id } = await concluding()
  f.host.projectSettings = async () => ({ lander: { checks: ['exit 1'] } })
  const { id: submission } = await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  expect(report).toContain('was not landed: check failed twice: exit 1')
  expect(await f.host.eventLog.recent({ events: [SubmissionFailed] })).toMatchObject([
    {
      fails: 'workspaces.landed',
      data: { submission, conversationId: id, reason: 'check failed twice: exit 1' },
    },
  ])
  expect(await concludedIds(f)).not.toContain(id)
  expect((await f.service.get(id, context))!.state).toBe('ready')
  const requests = await f.opened.harness.commit(
    async (tx) => ({
      branch: await tx.submissionByRequest(id, `lander:${submission}`),
      starter: await tx.submissionByRequest(ROOT_CONVERSATION_ID, `lander:${submission}`),
    }),
    context,
  )
  expect(requests.branch).toMatchObject({ type: 'input', status: 'done' })
  expect(requests.starter).toBeUndefined()
  expect(
    (await f.opened.root.context(context)).entries.filter(
      (entry) => entry.kind === 'workspaces.lander-report',
    ),
  ).toHaveLength(0)
})
it.concurrent('delivers a message to a resumed branch whose checkout conclude released', async () => {
  const { f, id } = await concluding()
  await f.service.submit(id, 'None', context)
  await until(async () => (await concludedIds(f)).includes(id))
  await until(async () => (await f.service.get(id, context))?.state === 'removed')
  const { path } = (await f.service.get(id, context))!
  // Release marks the record removed before it deletes the folder.
  await until(() =>
    access(path).then(
      () => false,
      () => true,
    ),
  )
  // Another branch landed meanwhile, so the resumed branch catches up on main.
  await commit(f.projectRoot, 'meanwhile.txt')
  await conversationActions.resume({ ids: [id] }, { host: f.host } as ActionContext)
  f.prepared.faux!.setResponses([() => fauxAssistantMessage('Back on it.')])
  const messages = f.host.want(MessagesApi)!
  const sent = await messages.send(
    ROOT_CONVERSATION_ID,
    { to: `#${id}`, text: 'Phase two, go.', reply: false },
    'resumed-message',
    context,
  )
  const stored = async () =>
    (await f.opened.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!.messages.find(
      (message) => message.id === sent,
    )!
  await until(async () => (await stored()).state !== 'sent')
  expect((await stored()).error).toBeUndefined()
  expect(await stored()).toMatchObject({ state: 'delivered', entry: expect.any(Number) })
  await f.opened.harness.waitForIdle(context)
  // Its run recreated the checkout.
  expect((await f.service.get(id, context))?.state).toBe('ready')
  await access(path)
})

it.concurrent('does not record a failed landing in the message log', async () => {
  const f = await lander({ checks: ['echo REJECTED; false'] }, undefined, true)
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  await submitted(f, id)
  expect(await messageLog(f)).toEqual([])
})
