/**
 * Keep warm: Claude Code, or the Anthropic API with keep-warm on, caches @ultimate's prompt for an hour after each
 * request. Shortly before that hour ends, with @ultimate idle and the user away less than 8 hours, one
 * request replays @ultimate's context as its next request would send it, plus a one-word question. It reads the whole
 * prefix from the cache, which renews the hour, and leaves nothing in any transcript; its tokens count toward
 * @ultimate's usage.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord'
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, HookApi, ModelRef } from '@earendil-works/pi-durable'
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import type { Context } from '@earendil-works/chord'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { ModelsApi } from '../models/api.ts'
import { PauseApi } from '../pause/api.ts'
import { Standing } from '../subagents/api.ts'
import { due, isOn, LEAD, outcome, TTL, warmStep } from './due.ts'
import { SetAction, StateAction, WarmDoc } from './refs.ts'
import type { Ping, WarmDocState, WarmState } from './refs.ts'

const State = defineDoc<WarmDocState>({
  kind: WarmDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]

/** How often the timer looks; a ping lands within a minute after `LEAD`, well inside the hour. */
const TICK = 60_000
/**
 * Caches for an hour (`ttl: "1h"`): Claude Code always; the Anthropic API while keep-warm is `on` (`hourCache` sets it
 * on @ultimate's requests), or for every request under `PI_CACHE_RETENTION=long`.
 */
export const hourLong = (provider: string, on: boolean) =>
  provider === 'claude-code' ||
  (provider === 'anthropic' && (on || process.env.PI_CACHE_RETENTION === 'long'))

// --- One-hour cache for @ultimate on the Anthropic API (#195080) ---
// pi-ai caches `anthropic` requests for 5 minutes unless PI_CACHE_RETENTION=long, which applies to every request of
// the process (all conversations, and every project the service runs). Measured on stored usage (#195080, Nov 5–10):
// @ultimate rewrote its whole 300–400k-token context after most 5–60 minute pauses; one hour plus pings cuts its
// input-equivalent cost by ~30%, while long retention for every conversation would add ~8% to all the others' writes.
// So only @ultimate's requests, on `anthropic` with keep-warm on, get the one-hour breakpoints.

/** The Anthropic Messages body with each cache breakpoint at one hour, as pi-ai's `cacheRetention: 'long'` sets it. */
function hourBreakpoints(payload: unknown) {
  type Block = { cache_control?: { type?: string } }
  const block = (value: Block) =>
    value?.cache_control?.type === 'ephemeral'
      ? { ...value, cache_control: { ...value.cache_control, ttl: '1h' } }
      : value
  const blocks = (list: unknown) => (Array.isArray(list) ? (list as Block[]).map(block) : list)
  const body = payload as { system?: unknown; tools?: unknown; messages: { content: unknown }[] }
  return {
    ...body,
    ...(body.system === undefined ? {} : { system: blocks(body.system) }),
    ...(body.tools === undefined ? {} : { tools: blocks(body.tools) }),
    messages: body.messages.map((message) => ({ ...message, content: blocks(message.content) })),
  }
}

/** `beforeProviderRequest`: one-hour breakpoints on @ultimate's Anthropic requests while keep-warm is on. */
export async function hourCache(
  { model, payload }: { readonly model: Model<Api>; readonly payload: unknown },
  api: Pick<HookApi, 'conversationId' | 'snapshot'>,
  ctx: Context,
) {
  if (model.provider !== 'anthropic' || model.api !== 'anthropic-messages') return undefined
  const standing = await api.snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  if (standing?.ultimate !== api.conversationId) return undefined
  if (!isOn((await api.snapshot(State, ROOT_CONVERSATION_ID, ctx)) ?? {})) return undefined
  return { payload: hourBreakpoints(payload) }
}
// --- end #195080 ---
const QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

const read = async (host: ExtensionHost) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? {}

const ultimateOf = async (host: ExtensionHost) =>
  (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate

/** The last ping, if it was on `model`: the same model id on another provider has another cache. */
export const lastOn = (last: Ping | undefined, model: ModelRef) =>
  last?.provider === model.provider && last.model === model.modelId ? last : undefined

/** A response that read or wrote `model`'s cache: an answer that came back, with cache tokens. */
export const cached = (message: AssistantMessage, model: ModelRef) =>
  message.provider === model.provider &&
  message.model === model.modelId &&
  message.stopReason !== 'error' &&
  message.stopReason !== 'aborted' &&
  message.usage.cacheRead + message.usage.cacheWrite > 0

/**
 * When @ultimate's own requests last renewed `model`'s cache (ms): its newest such response within the hour. A failed
 * response or one of another model renews nothing, so it does not count.
 */
async function answeredAt(host: ExtensionHost, id: ConversationId, model: ModelRef, now: number) {
  const conversation = (await host.harness().conversation(id, context))!
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, 100, cursor, context)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      if (now - message.timestamp >= TTL) return undefined
      if (cached(message, model)) return message.timestamp
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

/** @ultimate, its model and the times that decide a ping; undefined while its provider does not cache for an hour. */
async function activity(host: ExtensionHost, doc: WarmDocState, now: number) {
  const id = await ultimateOf(host)
  const conversation = id === undefined ? undefined : await host.harness().conversation(id, context)
  if (!conversation) return undefined
  const model = (await conversation.agent(context)).model
  if (!model || !hourLong(model.provider, isOn(doc))) return undefined
  const answered = await answeredAt(host, id!, model, now)
  const last = lastOn(doc.last, model)
  const pinged = last && outcome(last) === 'succeeded' ? last.at : undefined
  const lastRequest = Math.max(answered ?? 0, pinged ?? 0) || undefined
  return {
    id: id!,
    provider: model.provider,
    model: model.modelId,
    lastRequest,
    failedAfter: last && outcome(last) !== 'succeeded' ? last.at : undefined,
    inputAt: doc.inputAt,
  }
}

/** Not paused (also by a rate limit) and the cache still within its hour; synchronous, so nothing slips in after it. */
export const open = (paused: boolean | undefined, lastRequest: number, now: number) =>
  !paused && now - lastRequest < TTL

type Attempt = { at: number; provider: string; model: string; previous?: number }

/**
 * In one commit: record the attempt as interrupted, only while it is still on, @ultimate has no run and no other
 * attempt was recorded since the tick read `previous`. A crash mid-request then counts as a failure, never a retry.
 */
async function claim(host: ExtensionHost, id: ConversationId, attempt: Attempt) {
  return host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if ((await tx.doc(LiveDoc, id)).run) return false
    // Waiting on its primary after a limit (extensions/backup): a ping would only ask the limited model once more.
    if (await host.want(ModelsApi)?.limitWait(tx, id)) return false
    return warmStep(doc, { type: 'claim', ...attempt })
  }, context)
}

/** Store the attempt's outcome, with the response's usage on @ultimate when there is one, in one commit. */
async function record(
  host: ExtensionHost,
  id: ConversationId,
  last: Ping,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    warmStep(await tx.doc(State, ROOT_CONVERSATION_ID), { type: 'record', ping: last })
    if (answer)
      await host.need(ConversationsApi).accountResponse(tx, id, {
        provider: answer.provider,
        model: answer.model,
        usage: copyJson(answer.usage, {
          omitUndefinedProperties: true,
        }) as ResponseReceipt['usage'],
        text: '',
        stopReason: answer.stopReason,
      })
  }, context)
}

/**
 * One request with @ultimate's next context and the question, unless something changed while it was prepared. It is
 * recorded as interrupted before it is sent, so a crash never leads to a second try.
 */
async function ping(
  host: ExtensionHost,
  found: {
    id: ConversationId
    provider: string
    model: string
    lastRequest: number
    previous?: number
  },
) {
  const paused = () => host.want(PauseApi)?.paused()
  const { id, provider } = found
  const conversation = (await host.harness().conversation(id, context))!
  const agent = await conversation.agent(context)
  const model = host.modelRuntime.getModel(provider, found.model)
  if (!model) return
  let messages: Message[] = [...(await conversation.context(context)).messages]
  // As conversations' beforeRequest hook sends it (extensions/conversations/server.ts): the identity leads, once.
  const identity = `You are conversation #${id}.`
  if (!messages.some((message) => message.role === 'user' && message.content === identity))
    messages = [{ role: 'user', content: identity, timestamp: 0 }, ...messages]
  const at = Date.now()
  messages.push({ role: 'user', content: QUESTION, timestamp: at })
  // Preparing awaited: a pause, a new run or the switch may have come in meanwhile. The claim checks the switch and the
  // run in its commit; pause and the hour are checked again after it, with nothing awaited before the request starts.
  if (!open(paused(), found.lastRequest, Date.now())) return
  if (!(await claim(host, id, { at, provider, model: found.model, previous: found.previous })))
    return
  if (!open(paused(), found.lastRequest, Date.now())) {
    await record(host, id, {
      at,
      provider,
      model: found.model,
      error: 'skipped: paused or expired',
    })
    return
  }
  let answer: AssistantMessage
  try {
    // No sessionId: a one-shot Claude Code process, so @ultimate's own warm process never sees this turn.
    // Pi upstream: @earendil-works/pi-ai@1.5.0 src/api/anthropic-messages.ts — 1.5.0 has no message threads. Unreleased
    // pi-ai threads every `anthropic` request that carries a sessionId; without one this ping stays a full, unthreaded
    // request, which must still read the cache @ultimate's turns wrote. Before updating this marker, work through
    // "On the 1.6 upgrade" in docs/pi-upstream.md.
    answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
          // The same one-hour breakpoints as @ultimate's own requests (`hourCache`); Claude Code ignores it.
          cacheRetention: 'long',
          signal: AbortSignal.timeout(180_000),
        },
      )
      .result()
  } catch (error) {
    // Kept as the last ping: it blocks pings until @ultimate's next request, so a failure is never retried.
    await record(host, id, {
      at,
      provider,
      model: found.model,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  const failed = answer.stopReason === 'error' || answer.stopReason === 'aborted'
  await record(
    host,
    id,
    failed
      ? { at, provider, model: found.model, error: answer.errorMessage ?? answer.stopReason }
      : {
          at,
          provider,
          model: found.model,
          read: answer.usage.cacheRead,
          write: answer.usage.cacheWrite,
        },
    answer,
  )
}

async function tick(host: ExtensionHost) {
  // Paused, also by a rate limit: no request starts until Play.
  if (host.want(PauseApi)?.paused()) return
  const doc = await read(host)
  if (!isOn(doc)) return
  const now = Date.now()
  const found = await activity(host, doc, now)
  if (!found?.lastRequest || !due({ now, ...found })) return
  await ping(host, { ...found, lastRequest: found.lastRequest, previous: doc.last?.at })
}

async function state(host: ExtensionHost): Promise<WarmState> {
  const doc = await read(host)
  const now = Date.now()
  const found = await activity(host, doc, now)
  const on = isOn(doc)
  const base = {
    on,
    pings: doc.pings ?? 0,
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.inputAt === undefined ? {} : { inputAt: doc.inputAt }),
  }
  if (!found) return base
  const nextAt = found.lastRequest === undefined ? undefined : found.lastRequest + LEAD
  const will = on && nextAt !== undefined && due({ ...found, now: Math.max(now, nextAt) })
  return {
    ...base,
    ...(found.lastRequest === undefined ? {} : { lastRequest: found.lastRequest }),
    ...(will ? { nextAt } : {}),
  }
}

export default function keepWarm(host: ExtensionHost) {
  // Resolved where they are called; declared here so the catalogue lists them.
  host.need(ConversationsApi)
  host.want(PauseApi)
  // The user's latest input to @ultimate: typed, or an answer to its question.
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      if ((await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate !== data.conversation) return
      warmStep(await tx.doc(State, ROOT_CONVERSATION_ID), { type: 'input', at: Date.parse(at) })
    },
    { from: 'now' },
  )
  const shared = host.resource('keep-warm.timer', () => ({
    running: undefined as Promise<void> | undefined,
  }))
  const timer = setInterval(() => {
    shared.running ??= tick(host)
      .catch((error: unknown) => host.notice(`Keep warm: ${String(error)}`))
      .finally(() => {
        shared.running = undefined
      })
  }, TICK)
  host.onClose(async () => {
    clearInterval(timer)
    await shared.running
  })
  return defineExtension({
    name: 'keep-warm',
    hooks: [hook(GenerationTask, { beforeProviderRequest: hourCache })],
  })
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  set: implementAction(SetAction, async (args, { host }) => {
    const on = (args as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') throw new Error('Expected { on: boolean }')
    await host.harness().commit(async (tx) => {
      warmStep(await tx.doc(State, ROOT_CONVERSATION_ID), { type: 'switch', on })
    }, context)
    return state(host)
  }),
}
/** Pings spend the user's plan; only they turn them on or off. */
export const userActions = ['set']
