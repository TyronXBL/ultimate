/**
 * A conversation whose model answers with a rate limit, a capacity or a quota error switches to the next backup model of
 * its agent definition, and a run that starts `COOLDOWN_MINUTES` later puts the primary back. A model picked meanwhile
 * drops the record: the return is no longer this extension's to make.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai'
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
import { defaultModel, hasLogin, previewModel } from '../../lib/agents.ts'
import { limited, limitOf } from '../../lib/rate-limit.ts'
import { Pin } from '../models/api.ts'
import { Standing } from '../subagents/api.ts'
import { BackupApi } from './api.ts'
import { BackupDoc } from './refs.ts'
import type {
  BackupNotice,
  BackupRecord,
  BackupReturned,
  BackupState,
  BackupSwitch,
  ModelRef,
} from './refs.ts'

const State = defineDoc<BackupState>({
  kind: BackupDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]

/** Minutes a conversation stays on a backup before a run that starts later puts its primary back. */
const COOLDOWN_MINUTES = 30
const COOLDOWN = COOLDOWN_MINUTES * 60_000

type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'resource'
  | 'want'
  | 'modelRuntime'
  | 'settings'
  | 'implement'
  | 'onOpen'
  | 'onClose'
  | 'onRelease'
>

const model = (ref: { provider: string; modelId: string }): ModelRef => ({
  provider: ref.provider,
  modelId: ref.modelId,
})
const name = (ref: { provider: string; modelId: string }) => `${ref.provider}/${ref.modelId}`

/** The record `state` holds, once it holds all of one. */
function active(state: BackupState): BackupRecord | undefined {
  const { primary, to, since, tried } = state
  if (!primary || !to || since === undefined) return undefined
  return {
    primary,
    to,
    since,
    tried: tried ?? [],
    ...(state.thinking ? { thinking: state.thinking } : {}),
  }
}

/** A provider's error text, short enough for a card: the first 300 characters. */
const short = (error: string) => (error.length > 300 ? `${error.slice(0, 300)}…` : error)

const clear = (state: BackupState) => {
  delete state.primary
  delete state.thinking
  delete state.to
  delete state.since
  delete state.tried
}

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
      // A conversation that follows the default runs on it: that is the model this answer came from.
      const current = agent.model ?? defaultModel(available, host.settings)
      if (!current) return undefined
      const state = await tx.doc(State, id)
      const failed = `${message.provider}/${message.model}`
      // A switch made after this response was asked for: the conversation already left the model that failed here.
      if (failed !== name(current))
        return (state.tried ?? []).includes(failed) ? { earlier: true as const } : undefined
      const definition = await host.want(Pin)?.definition(tx, id)
      const used = new Set([...(state.tried ?? []), failed])
      const to = definition?.fallback?.find(
        (candidate) => !used.has(name(candidate)) && hasLogin(available, candidate),
      )
      if (!to) return undefined
      // The first switch keeps the primary; the next one keeps the primary the conversation came from.
      const primary = state.primary ?? current
      const thinking = state.thinking ?? agent.thinkingLevel
      const level = to.thinking ?? thinking
      agent.model = model(to)
      const runtime = host.modelRuntime.getModel(to.provider, to.modelId)
      if (level && runtime) agent.thinkingLevel = clampThinkingLevel(runtime, level)
      const switched: Switched = {
        from: name(current),
        to: name(to),
        reason: limitOf(message.errorMessage ?? '') ?? 'rate limit',
      }
      Object.assign(state, {
        primary,
        to: agent.model,
        since: Date.now(),
        tried: [...(state.tried ?? []), switched.from],
        ...(thinking ? { thinking } : {}),
      })
      return switched
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
  const switchEntry: EntryDraft = {
    kind: 'backup.switch',
    data,
    model: [
      {
        role: 'user',
        content: `Model ${data.from} answered with a ${data.reason} error; this conversation now runs on ${data.to} and returns to ${data.from} at its first run ${COOLDOWN_MINUTES} minutes from now.`,
        timestamp: Date.now(),
      },
    ],
  }
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
 * `backup.return` divider. A model set by someone else (a pick, `models.fallback`) drops the record instead, and so does
 * a primary that has no login here yet: the backup stays, and the next run looks again.
 */
async function returned(
  host: Host,
  tx: Tx,
  id: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const state = await tx.doc(State, id)
  if (!state.to) return undefined
  const record = active(state)
  const agent = await tx.doc(AgentDoc, id)
  if (!record || !agent.model || name(agent.model) !== name(record.to)) {
    clear(state)
    return undefined
  }
  const now = Date.now()
  if (now < record.since + COOLDOWN) return undefined
  if (!hasLogin(host.modelRuntime.getAvailableSnapshot(), record.primary)) return undefined
  agent.model = model(record.primary)
  if (record.thinking) agent.thinkingLevel = record.thinking
  else delete agent.thinkingLevel
  clear(state)
  const data: BackupReturned = { from: name(record.to), to: name(record.primary) }
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
    unsubscribe = host.harness().subscribeCommits((publication) => {
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
        // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched transactional beforeInput hook. Every run's first
        // input is placed through it (a typed input, a delivery, a queued follow-up), before the run reads its agent.
        beforeInput: (_input, { tx, conversationId }) => returned(host, tx, conversationId),
      }),
    ],
  })
}
