/**
 * A conversation whose model answers with a rate limit, a capacity or a quota error switches to the next backup model of
 * its agent definition, and a run that starts `COOLDOWN_MINUTES` later puts the primary back. When no backup can take the
 * limit, it goes back to its primary and waits to try it again; the watchdog continues its run then, and the primary's
 * first answer ends the wait. A model set meanwhile (a pick, a login fallback, a creator's start) replaces the owner's
 * record: the return is no longer this extension's to make.
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
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { hasLogin, previewModel } from '../../lib/agents.ts'
import { onCommit } from '../../lib/commits.ts'
import { limited, limitOf } from '../../lib/rate-limit.ts'
import { BackupOrder, LoginChanged, ModelsApi, Pin, Resets } from '../models/api.ts'
import type { Refusal } from '../models/api.ts'
import { ContextUsageDoc } from '../conversations/api.ts'
import { Standing } from '../subagents/api.ts'
import { BackupApi } from './api.ts'
import { BackupDoc } from './refs.ts'
import {
  backupOf,
  backupOrder,
  backupStep,
  COOLDOWN_MINUTES,
  exhaustedStep,
  exhaustedUntil,
  fromLegacy,
  jitterOf,
  legacyHolds,
  name,
} from './state.ts'
import type { Exhausted, ExhaustedEvent } from './state.ts'
import type {
  BackupNotice,
  BackupReturned,
  BackupState,
  BackupSwitch,
  BackupWait,
  ModelRef,
  Skipped,
} from './refs.ts'

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
/** The models this machine knows to be out of quota (`Exhausted`), on the root; only `exhaust` writes it. */
const ExhaustedState = defineDoc<Exhausted>({
  kind: 'backup.exhausted',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State, ExhaustedState]

/** Record `event` in the exhausted models inside `tx` (`exhaustedStep`), and return them. */
async function exhaust(tx: Tx, event: ExhaustedEvent, now: number) {
  const doc = await tx.doc(ExhaustedState, ROOT_CONVERSATION_ID)
  const next = exhaustedStep(doc, event, now)
  // An event that changes nothing leaves no revision.
  if (JSON.stringify(next) !== JSON.stringify(doc)) {
    for (const key of Object.keys(doc)) Reflect.deleteProperty(doc, key)
    Object.assign(doc, next)
  }
  return next
}

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
  return backupOf(await models.owner(tx, id))
}

/**
 * Tokens a backup's window keeps free beyond the conversation: a model with less room would start a blocking compaction
 * at once (Pi compacts above `contextWindow - reserveTokens`), whose summary needs a model the limit may have left none
 * of (#189897, #191380). Deliberately the largest reserve server/harness.ts gives any window (32k from 500k up; Pi's
 * 16k below), so a backup that fits also has room for the answer this run owes.
 */
const RESERVE = 32_768

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`

/**
 * Why backup `ref` cannot take conversation `id` now, inside `tx`: no login here, a quota this machine saw exhausted
 * (`exhausted`, at `now`), or a window too small for its context. Undefined when it can.
 */
async function skipper(host: Host, tx: Tx, id: ConversationId, exhausted: Exhausted, now: number) {
  const available = host.modelRuntime.getAvailableSnapshot()
  const tokens = (await tx.doc(ContextUsageDoc, id)).tokens ?? 0
  return (ref: ModelRef) => {
    if (!hasLogin(available, ref)) return 'no login'
    const until = exhaustedUntil(exhausted, name(ref), now)
    if (until === Infinity) return 'out of credit'
    if (until !== undefined) return `quota until ${utc(until)}`
    const window = host.modelRuntime.getModel(ref.provider, ref.modelId)?.contextWindow
    if (window && tokens + RESERVE > window)
      return `${thousands(window)} window, ${thousands(tokens)} context`
    return undefined
  }
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
  | 'react'
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

/** How long a switch waits for the provider's reset time before it decides without it. */
const RESET_WAIT = 1_500
/** How long a quota counts while its provider's reset is still being read, until the reading corrects it. */
const READING_FOR = 60 * 60_000
const delay = (ms: number) =>
  new Promise<undefined>((done) => setTimeout(done, ms, undefined).unref())

type Switched = Pick<BackupSwitch, 'from' | 'to' | 'reason'>
type Waiting = { from: string; primary: string; reason: string; since: number; until: number }
/** What a model answered with a limit: an assistant entry, or a refusal of work beside the conversation. */
type Answer = Pick<AssistantMessage, 'provider' | 'model' | 'errorMessage'>

/**
 * Switch conversation `id` off the model that answered `message` with a limit: to the first of its definition's backup
 * models that has a login here, room for its context and was not tried yet, recording the primary to return to; or,
 * when none can take it, back to the primary to wait. `others` refused the same work after it (a summary's backups): none
 * of them is taken, and a quota among them counts as exhausted. `known` is the reset of `message`'s provider when it was
 * read already. One commit, so a conversation runs on the backup or the primary with the record, or on neither. Undefined
 * when nothing changed.
 */
async function switchNow(
  host: Host,
  id: ConversationId,
  message: Answer,
  others: Refusal[] = [],
  known?: { reset?: number },
) {
  const failed = `${message.provider}/${message.model}`
  const limit = limitOf(message.errorMessage ?? '') ?? 'rate limit'
  // An exhausted quota resets when its provider says. The reading asks the provider (up to 15 s), and the watchdog reads
  // this switch or wait 5 s after the failure: the commit waits for it only briefly. A reading still out, or failed, is
  // no answer that the provider reports no reset: the quota counts for `READING_FOR`, so a primary's wait still starts,
  // and a late reading corrects only the exhausted model's time, which no watchdog reads (review of #207552).
  const reading =
    limit === 'quota' && !known
      ? host
          .want(Resets)
          ?.resetsAt(message.provider)
          .then(
            (at) => ({ at }),
            () => undefined,
          )
      : undefined
  const read = reading && (await Promise.race([reading, delay(RESET_WAIT)]))
  const reset = known ? known.reset : read ? read.at : reading && Date.now() + READING_FOR
  if (reading && !read)
    reading
      .then(async (late) => {
        if (!late) return
        await serial(host, () =>
          host.harness().commit(async (tx) => {
            // Its answer or a login meanwhile cleared it: the reading has nothing left to correct.
            if (!Object.hasOwn(await tx.doc(ExhaustedState, ROOT_CONVERSATION_ID), failed)) return
            const error = short(message.errorMessage ?? '')
            const at = late.at === undefined ? {} : { reset: late.at }
            await exhaust(tx, { type: 'quota', model: failed, ...at, error }, Date.now())
          }, context),
        )
      })
      .catch((error: unknown) => {
        // The model stays exhausted until `READING_FOR` passes instead.
        console.error('backup: recording a quota reset failed:', error)
      })
  return serial(host, () =>
    host.harness().commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, id)
      // Every conversation runs on a model of its own: Pi answers a run without one `no_model`, never with a limit.
      const current = agent.model
      if (!current) return undefined
      const now = Date.now()
      // Every conversation skips a model this one found out of quota, until it resets (#191380 and its siblings each
      // tried the same two exhausted backups).
      let exhausted = await tx.doc(ExhaustedState, ROOT_CONVERSATION_ID)
      const quotas = [
        { model: failed, error: message.errorMessage ?? '', ...(reset ? { reset } : {}) },
        ...others.map((other) => ({ ...other, model: name(other.model) })),
      ].filter((answer) => limitOf(answer.error) === 'quota')
      for (const { model, error, reset: at } of quotas)
        exhausted = await exhaust(
          tx,
          { type: 'quota', model, ...(at ? { reset: at } : {}), error: short(error) },
          now,
        )
      const backup = await backupFor(host, tx, id)
      const definition = await host.want(Pin)?.definition(tx, id)
      const primary = backup.kind === 'primary' ? current : backup.primary
      const primaryReset = exhaustedUntil(exhausted, name(primary), now)
      const skip = await skipper(host, tx, id, exhausted, now)
      const refused = new Map(
        others.map((other) => [name(other.model), limitOf(other.error) ?? 'error']),
      )
      const { state, outcome: step } = backupStep(backup, {
        type: 'limit',
        current,
        currentThinking: agent.thinkingLevel,
        failed,
        reason: limit,
        candidates: definition?.fallback ?? [],
        skip: (ref) =>
          skip(ref) ??
          (refused.has(name(ref)) ? `${refused.get(name(ref))} on the summary` : undefined),
        // A wait for a primary out of quota lasts until its quota resets; one out of credit (`Infinity`) starts none.
        ...(primaryReset === undefined ? {} : { reset: primaryReset }),
        jitter: jitterOf(id),
        now,
      })
      const models = host.need(ModelsApi)
      if (step.kind === 'earlier' || step.kind === 'held') return { kind: 'handled' as const }
      if (step.kind === 'gave-up') {
        await models.setModel(tx, id, { type: 'return' })
        return undefined
      }
      // The outcome says why; the state, which the owner keeps, says what.
      if (step.kind === 'waiting' && state.kind === 'waiting') {
        await models.setModel(tx, id, { type: 'wait', record: state })
        const { reason, since, until, attempt } = state
        const data: Waiting = {
          from: step.from,
          primary: name(state.primary),
          reason,
          since,
          until,
        }
        return { kind: 'waiting' as const, ...data, attempt, skipped: step.skipped }
      }
      if (step.kind !== 'switched' || state.kind !== 'backup') return undefined
      const level = clamped(host, step.to, step.level)
      await models.setModel(tx, id, {
        type: 'backup',
        record: state,
        ...(level ? { level } : {}),
      })
      return {
        kind: 'switched' as const,
        from: step.from,
        to: name(step.to),
        reason: step.reason,
      } satisfies Switched & { kind: 'switched' }
    }, context),
  )
}

/**
 * One line in @ultimate's transcript about conversation `id`. @ultimate reads the same card in its own conversation;
 * only another conversation's switch or wait needs a line there.
 */
async function notify(host: Host, id: ConversationId, entry: number, notice: BackupNotice) {
  const harness = host.harness()
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (ultimate === undefined || ultimate === id) return
  const content =
    notice.until === undefined
      ? `Its model ${notice.from} answered with a ${notice.reason} error, so it runs on ${notice.to} until a run starts ${COOLDOWN_MINUTES} minutes from now.`
      : `Its model ${notice.from} answered with a ${notice.reason} error and no backup model can take it, so it waits and continues on its primary ${notice.to} by itself at ${utc(notice.until)}.`
  await (
    await harness.conversation(ultimate, context)
  )?.submit(
    {
      type: 'write',
      requestId: `backup.notice:${entry}`,
      entry: {
        kind: 'backup.notice',
        data: notice,
        model: [{ role: 'user', content, timestamp: Date.now() }],
      },
    },
    context,
  )
}

const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** The card where a wait began, and @ultimate's line about it. */
async function waitCard(
  host: Host,
  id: ConversationId,
  message: Answer,
  entry: number,
  waiting: Waiting & { skipped: Skipped[] },
) {
  const { from, primary, reason, since, until, skipped } = waiting
  const data: BackupWait = {
    from,
    primary,
    reason,
    since,
    until,
    skipped,
    error: short(message.errorMessage ?? ''),
  }
  // Only kind and data, as the switch card: a model line waits for the run to end, and a run that fails keeps it queued
  // until the next one, the wait's own continuation (#207552). The continuation's input names the error.
  await (
    await host.harness().conversation(id, context)
  )?.submit(
    { type: 'write', requestId: `backup.wait:${entry}`, entry: { kind: 'backup.wait', data } },
    context,
  )
  await notify(host, id, entry, {
    conversation: id,
    from: waiting.from,
    to: waiting.primary,
    reason: waiting.reason,
    until: waiting.until,
  })
}

/**
 * Switch the conversation away from a model that answered with a limit, and say so: one `backup.switch` card in the
 * conversation and one `backup.notice` line in @ultimate's. True when it runs on a backup because of this failure, so a
 * failure reported twice (`Backup.fallBack` and the commit that recorded it) leaves one card. `entry` names the failure
 * in the cards' request ids: the answer's entry, or the task of the work `others` refused too (`switchNow`, as `known`);
 * entries and tasks share one id sequence.
 */
export async function fallBack(
  host: Host,
  id: ConversationId,
  message: Answer,
  entry: number,
  others: Refusal[] = [],
  known?: { reset?: number },
) {
  if (previewModel()) return false
  const result = await switchNow(host, id, message, others, known)
  if (!result) return false
  if (result.kind === 'handled') return true
  if (result.kind === 'waiting') {
    // A wait that goes on after a try of the primary keeps the first card, which reads the wait live.
    if (result.attempt === 1) await waitCard(host, id, message, entry, result)
    return true
  }
  const { kind: _, ...switched } = result
  const harness = host.harness()
  const data: BackupSwitch = {
    ...switched,
    error: short(message.errorMessage ?? ''),
    cooldown: COOLDOWN_MINUTES,
  }
  // Only kind and data, so Pi appends it at once beside the failed answer while the run retries; a model line would wait
  // for the run to end and land after the backup's answer.
  const switchEntry: EntryDraft = { kind: 'backup.switch', data }
  await (
    await harness.conversation(id, context)
  )?.submit({ type: 'write', requestId: `backup.switch:${entry}`, entry: switchEntry }, context)
  await notify(host, id, entry, {
    conversation: id,
    from: data.from,
    to: data.to,
    reason: data.reason,
  })
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

/**
 * `message` answered conversation `id`: its model has room again, so no conversation skips it as out of quota, and the
 * primary of a waiting conversation ends the wait, which returns the owner to the one before it.
 */
function resume(host: Host, id: ConversationId, message: AssistantMessage) {
  const model = `${message.provider}/${message.model}`
  // Not in the switches' queue: a read for each answer must not hold up a switch the watchdog waits for. A switch and an
  // answer of one conversation never race, as its run makes one request at a time.
  return host.harness().commit(async (tx) => {
    const now = Date.now()
    if (exhaustedUntil(await tx.doc(ExhaustedState, ROOT_CONVERSATION_ID), model, now))
      await exhaust(tx, { type: 'answered', model }, now)
    const models = host.need(ModelsApi)
    const wait = await models.limitWait(tx, id)
    if (!wait) return
    const { outcome } = backupStep({ kind: 'waiting', ...wait }, { type: 'answered', model })
    if (outcome.kind === 'resumed') await models.setModel(tx, id, { type: 'return' })
  }, context)
}

export default function extension(host: Host) {
  // Another account may have room: what this machine knew of the provider's quota no longer holds.
  host.react('exhausted-login', [LoginChanged], async (tx, { data }) => {
    await exhaust(tx, { type: 'login', provider: data.provider }, Date.now())
  })
  host.implement(BackupApi, {
    fallBack: (id, message, entry) => fallBack(host, id, message, entry),
  })
  host.implement(BackupOrder, {
    async order(tx, id) {
      const agent = await tx.doc(AgentDoc, id)
      if (previewModel() || !agent.model) return []
      // Only a read: a `backup.state` record that still holds counts until a run moves it (`backupFor`).
      const owner = await host.need(ModelsApi).owner(tx, id)
      const legacy = await tx.doc(State, id)
      const now = Date.now()
      const exhausted = await tx.doc(ExhaustedState, ROOT_CONVERSATION_ID)
      const order = backupOrder(
        legacyHolds(legacy, owner, agent.model) ? legacy : backupOf(owner),
        {
          current: agent.model,
          currentThinking: agent.thinkingLevel,
          candidates: (await host.want(Pin)?.definition(tx, id))?.fallback ?? [],
          // A summary reads the whole conversation: a model without room for it cannot write one either; nor can one out
          // of quota.
          skip: await skipper(host, tx, id, exhausted, now),
          now,
        },
      )
      return order.map(({ thinking, ...ref }) => {
        const level = clamped(host, ref, thinking)
        return level ? { ...ref, thinking: level } : ref
      })
    },
    // A summary no model could write: its own model's limit decides as that model's answer would, the backups after it
    // count as tried, so the conversation waits on its primary instead of failing its run (#207552).
    async refused(id, [own, ...others], key) {
      if (!own) return
      const answer = {
        provider: own.model.provider,
        model: own.model.modelId,
        errorMessage: own.error,
      }
      // Lineage read the own model's reset already, and waited for it.
      await fallBack(host, id, answer, key, others, own.reset ? { reset: own.reset } : {})
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
    // Every model answer Pi records lands in a commit; the first one a limit ends switches the conversation, and an
    // answer of a waiting conversation's primary ends its wait.
    unsubscribe = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        const message = change.type === 'entry' ? change.value.model?.[0] : undefined
        if (change.type !== 'entry' || message?.role !== 'assistant') continue
        if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
          resume(host, change.value.conversationId, message).catch((error: unknown) => {
            // The wait stands; the primary's next answer ends it.
            console.error('backup: ending a wait failed:', error)
          })
          continue
        }
        if (message.stopReason !== 'error' || !limited(message.errorMessage ?? '')) continue
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
