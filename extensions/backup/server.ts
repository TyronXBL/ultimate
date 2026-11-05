/**
 * A conversation whose model answers with a rate limit, a capacity or a quota error switches to the next backup model of
 * its agent definition, and a run that starts `COOLDOWN_MINUTES` later puts the primary back. A model set meanwhile
 * (a pick, a login fallback, a creator's start) replaces the owner's record: the return is no longer this extension's to
 * make.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { AssistantMessage, ModelThinkingLevel } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, EntryId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { hasLogin, previewModel } from '../../lib/agents.ts'
import { onCommit } from '../../lib/commits.ts'
import { limited, limitOf } from '../../lib/rate-limit.ts'
import { BackupOrder, ModelsApi, Pin } from '../models/api.ts'
import { Standing } from '../subagents/api.ts'
import { BackupApi } from './api.ts'
import { BackupDoc } from './refs.ts'
import {
  backupOf,
  backupOrder,
  backupStep,
  COOLDOWN_MINUTES,
  fromLegacy,
  legacyHolds,
  name,
} from './state.ts'
import type { BackupNotice, BackupReturned, BackupState, BackupSwitch, ModelRef } from './refs.ts'

const State = defineDoc<BackupState>({
  kind: BackupDoc.kind,
  checkpointWhen: () => false,
  version: 3,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ kind: 'primary' }),
  // Version 1 held the record's fields, all optional, and `{}` while on the primary; version 2 recorded no limit.
  migrate: (value) => fromLegacy(value),
})
export const docs = [State]

/**
 * The backup of conversation `id` inside `tx`, after moving a `backup.state` record from before backups were an owner
 * state into the owner when it still holds (`legacyHolds`), and dropping it either way. Can go once no host has one.
 */
async function backupFor(host: Host, tx: Tx, id: ConversationId) {
  const models = host.need(ModelsApi)
  const legacy = await tx.doc(State, id)
  if (legacy.kind === 'backup') {
    if (legacyHolds(legacy, await models.owner(tx, id), (await tx.doc(AgentDoc, id)).model))
      await models.setModel(tx, id, { type: 'backup', record: legacy })
    for (const key of Object.keys(legacy)) Reflect.deleteProperty(legacy, key)
    Object.assign(legacy, { kind: 'primary' } satisfies BackupState)
  }
  return backupOf(await models.backup(tx, id))
}

type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'resource'
  | 'want'
  | 'need'
  | 'modelRuntime'
  | 'implement'
  | 'onOpen'
  | 'onClose'
  | 'onRelease'
>

/** `level` as far as model `ref` supports it; undefined without a level, or for a model this machine does not know. */
const clamped = (host: Host, ref: ModelRef, level: ModelThinkingLevel | undefined) => {
  const runtime = host.modelRuntime.getModel(ref.provider, ref.modelId)
  return level && runtime ? clampThinkingLevel(runtime, level) : undefined
}

/** A provider's error text, short enough for a card: the first 300 characters. */
const short = (error: string) => (error.length > 300 ? `${error.slice(0, 300)}…` : error)

/** One switch at a time, across reloads: two failures in one publication must not both take the next backup. */
function serial<T>(host: Pick<ExtensionHost, 'resource'>, work: () => Promise<T>): Promise<T> {
  const queue = host.resource('backup.queue', () => ({
    chain: Promise.resolve() as Promise<unknown>,
  }))
  const next = queue.chain.then(work)
  // The caller gets the failure; the chain only waits for the work to settle.
  queue.chain = next.catch(() => undefined)
  return next
}

type Switched = Pick<BackupSwitch, 'from' | 'to' | 'reason'>

/**
 * Switch conversation `id` off the model that answered `message` with a limit: to the first of its definition's backup
 * models that has a login here and was not tried yet, recording the primary to return to. One commit, so a conversation
 * either runs on the backup with the record or on neither. False when there is no backup left to take.
 */
function switchNow(host: Host, id: ConversationId, message: AssistantMessage) {
  return serial(host, () =>
    host.harness().commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, id)
      const available = host.modelRuntime.getAvailableSnapshot()
      // Every conversation runs on a model of its own: Pi answers a run without one `no_model`, never with a limit.
      const current = agent.model
      if (!current) return undefined
      const backup = await backupFor(host, tx, id)
      const definition = await host.want(Pin)?.definition(tx, id)
      const { state, outcome: step } = backupStep(backup, {
        type: 'limit',
        current,
        currentThinking: agent.thinkingLevel,
        failed: `${message.provider}/${message.model}`,
        reason: limitOf(message.errorMessage ?? '') ?? 'rate limit',
        candidates: definition?.fallback ?? [],
        hasLogin: (ref) => hasLogin(available, ref),
        now: Date.now(),
      })
      if (step.kind === 'earlier') return { earlier: true as const }
      if (step.kind !== 'switched' || state.kind !== 'backup') return undefined
      const level = clamped(host, step.to, step.level)
      await host.need(ModelsApi).setModel(tx, id, {
        type: 'backup',
        record: state,
        ...(level ? { level } : {}),
      })
      return { from: step.from, to: name(step.to), reason: step.reason } satisfies Switched
    }, context),
  )
}

/**
 * Switch the conversation away from a model that answered with a limit, and say so: one `backup.switch` card in the
 * conversation and one `backup.notice` line in @ultimate's. True when it runs on a backup because of this failure, so a
 * failure reported twice (`Backup.fallBack` and the commit that recorded it) leaves one card.
 */
export async function fallBack(
  host: Host,
  id: ConversationId,
  message: AssistantMessage,
  entry: EntryId,
) {
  if (previewModel()) return false
  const result = await switchNow(host, id, message)
  if (!result) return false
  if ('earlier' in result) return true
  const harness = host.harness()
  const data: BackupSwitch = {
    ...result,
    error: short(message.errorMessage ?? ''),
    cooldown: COOLDOWN_MINUTES,
  }
  // Only kind and data, so Pi appends it at once beside the failed answer while the run retries; a model line would wait
  // for the run to end and land after the backup's answer.
  const switchEntry: EntryDraft = { kind: 'backup.switch', data }
  await (
    await harness.conversation(id, context)
  )?.submit({ type: 'write', requestId: `backup.switch:${entry}`, entry: switchEntry }, context)
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  // @ultimate reads the same card in its own conversation; only another conversation's switch needs a line there.
  if (ultimate !== undefined && ultimate !== id) {
    const notice: BackupNotice = {
      conversation: id,
      from: data.from,
      to: data.to,
      reason: data.reason,
    }
    await (
      await harness.conversation(ultimate, context)
    )?.submit(
      {
        type: 'write',
        requestId: `backup.notice:${entry}`,
        entry: {
          kind: 'backup.notice',
          data: notice,
          model: [
            {
              role: 'user',
              content: `Its model ${notice.from} answered with a ${notice.reason} error, so it runs on ${notice.to} until a run starts ${COOLDOWN_MINUTES} minutes from now.`,
              timestamp: Date.now(),
            },
          ],
        },
      },
      context,
    )
  }
  return true
}

/**
 * The input hook: a conversation `COOLDOWN` into a switch, at the start of a run, goes back to its primary with one
 * `backup.return` divider. A primary that has no login here yet keeps the backup, and the next run looks again.
 */
async function returned(
  host: Host,
  tx: Tx,
  id: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const now = Date.now()
  const { outcome: step } = backupStep(await backupFor(host, tx, id), {
    type: 'run',
    now,
    hasPrimaryLogin: (ref) => hasLogin(host.modelRuntime.getAvailableSnapshot(), ref),
  })
  if (step.kind !== 'returned') return undefined
  await host.need(ModelsApi).setModel(tx, id, { type: 'return' })
  const data: BackupReturned = { from: step.from, to: step.to }
  return {
    entries: [
      {
        kind: 'backup.return',
        data,
        model: [
          {
            role: 'user',
            content: `Back on ${data.to} after ${COOLDOWN_MINUTES} minutes on the backup ${data.from}.`,
            timestamp: now,
          },
        ],
      },
    ],
  }
}

export default function extension(host: Host) {
  host.implement(BackupApi, {
    fallBack: (id, message, entry) => fallBack(host, id, message, entry),
  })
  host.implement(BackupOrder, {
    async order(tx, id) {
      const agent = await tx.doc(AgentDoc, id)
      if (previewModel() || !agent.model) return []
      const available = host.modelRuntime.getAvailableSnapshot()
      // Only a read: a `backup.state` record that still holds counts until a run moves it (`backupFor`).
      const models = host.need(ModelsApi)
      const legacy = await tx.doc(State, id)
      const order = backupOrder(
        legacyHolds(legacy, await models.owner(tx, id), agent.model)
          ? legacy
          : backupOf(await models.backup(tx, id)),
        {
          current: agent.model,
          currentThinking: agent.thinkingLevel,
          candidates: (await host.want(Pin)?.definition(tx, id))?.fallback ?? [],
          hasLogin: (ref) => hasLogin(available, ref),
          now: Date.now(),
        },
      )
      return order.map(({ thinking, ...ref }) => {
        const level = clamped(host, ref, thinking)
        return level ? { ...ref, thinking: level } : ref
      })
    },
  })
  let unsubscribe: (() => void) | undefined
  const close = async () => {
    unsubscribe?.()
    unsubscribe = undefined
  }
  host.onClose(close)
  host.onRelease(close)
  host.onOpen(async () => {
    unsubscribe?.()
    // Every model answer Pi records lands in a commit; the first one a limit ends switches the conversation.
    unsubscribe = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        const message = change.type === 'entry' ? change.value.model?.[0] : undefined
        if (
          change.type !== 'entry' ||
          message?.role !== 'assistant' ||
          message.stopReason !== 'error' ||
          !limited(message.errorMessage ?? '')
        )
          continue
        fallBack(host, change.value.conversationId, message, change.value.id).catch(
          (error: unknown) => {
            // The failed response stands, and Pi's retry runs on the same model: the next answer that hits the limit
            // tries the switch again.
            console.error('backup: switching to a backup model failed:', error)
          },
        )
      }
    })
  })
  return defineExtension({
    name: 'backup',
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.5.0 — patched transactional beforeInput hook. Every run's first
        // input is placed through it (a typed input, a delivery, a queued follow-up), before the run reads its agent.
        beforeInput: (_input, { tx, conversationId }) => returned(host, tx, conversationId),
      }),
    ],
  })
}
