import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import type { JsonValue } from '@earendil-works/chord'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  SubmissionRecord,
  TaskRecord,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { concurrencyCapped, limited, rateLimited } from '../../lib/rate-limit.ts'
import { Messages } from '../messages/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { ModelsApi, Pin } from '../models/api.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import { idleNote } from './idle.ts'
import { WatchdogApi } from './api.ts'
import type { ReportedFailure } from './api.ts'
import type { Failure } from './refs.ts'

/** How long after a temporary failure its one retry starts. */
const RETRY_AFTER = 60_000
/**
 * How long after a limit that switched the conversation to a backup model its continuation starts: the switch is made,
 * so only the commit that records it is waited for.
 */
const BACKUP_RETRY_AFTER = 5_000
/** Reported failures kept for `failures()`; older ones drop off. */
export const FAILURE_LIMIT = 20

const Reported = defineDoc<{ failures: ReportedFailure[] }>({
  kind: 'watchdog.reported',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ failures: [] }),
})

const Receipts = defineDoc<{ highWater?: number; tasks: Record<string, true> }>({
  kind: 'watchdog.receipts',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ tasks: {} }),
})
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
const failed = (task: TaskRecord<JsonValue, JsonValue, JsonValue>) =>
  task.kind === GenerationTask.definition.name &&
  task.state.status === 'terminal' &&
  task.state.outcome.status === 'failed' &&
  ['model_error', 'no_model'].includes(
    (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason ?? '',
  )
const failedInput = (input: SubmissionRecord) =>
  input.type === 'input' &&
  input.status === 'unanswered' &&
  ['model_error', 'no_model'].includes(input.reason)

/** The final error entry of a generation, excluding any later run. Pi can append several
 * assistant errors during its internal retries; only the last one ended the run. */
async function boundary(tx: Tx, task: Generation, next?: Generation) {
  let upper = Number(task.id)
  let assistant: AssistantMessage | undefined
  if (
    task.state.status === 'terminal' &&
    task.state.outcome.status === 'failed' &&
    (task.state.outcome.error.detail as { reason?: string } | undefined)?.reason === 'model_error'
  ) {
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanEntries(
        {
          conversationId: task.conversationId,
          minEntryId: task.id as number as EntryId,
          ...(next ? { maxEntryId: (next.id - 1) as EntryId } : {}),
          order: 'descending',
        },
        100,
        cursor,
      )
      const entry = page.items.find((candidate) => candidate.model?.[0]?.role === 'assistant')
      const message = entry?.model?.[0]
      if (message?.role === 'assistant') {
        if (message.stopReason === 'error') {
          upper = entry!.id
          assistant = message
        }
        break
      }
      cursor = page.next
    } while (cursor)
  }
  return { upper, assistant }
}

/**
 * What a failed run's error asks for: a broken login needs the user, so it reports at once with a hint to log in again;
 * a rate limit that outlasted Pi's retries reports once and never re-prompts into the limit; an incomplete Claude Code
 * relay response (status 200 or unknown) is a dropped stream, and a provider's per-user concurrency cap frees itself,
 * so both retry like Pi's own retryable errors.
 */
export function diagnose(error: string, assistant?: AssistantMessage) {
  if (rateLimited(error))
    return {
      hint: 'Still rate limited after Pi’s retries; once the limit resets (or the agent definition has a backup model in its `fallback`), resume this conversation with a message',
      temporary: false,
    }
  if (/not logged in/i.test(error))
    return { hint: 'Run `claude auth login` in a terminal', temporary: false }
  // The conversation's model has no login here; its next input switches it to one that has.
  const missing = /Provider is not configured: ([\w-]+)|No API key (?:found )?for "?([\w-]+)/i.exec(
    error,
  )
  if (missing)
    return {
      hint: `${missing[1] ?? missing[2]} has no login here. Log in again (⌘K → Log in to a provider), or message the conversation: its next run switches to a model that has one`,
      temporary: false,
    }
  const provider = /OAuth refresh failed for ([\w-]+)/i.exec(error)?.[1] ?? assistant?.provider
  if (/OAuth refresh failed|invalid_grant/i.test(error))
    return {
      hint: `Log in to ${provider ?? 'the provider'} again: ⌘K → Log in to a provider`,
      temporary: false,
    }
  return {
    temporary:
      concurrencyCapped(error) ||
      /^Incomplete Claude Code upstream response \(status (200|unknown),/.test(error) ||
      !!(assistant && isRetryableAssistantError(assistant)),
  }
}

type Generation = TaskRecord<JsonValue, JsonValue, JsonValue>
/** Live commits give us the exact settled inputs. On reopen, only model_error/no_model
 * submissions matter: their entries lie between consecutive failed-run boundaries.
 * Successful and stopped runs cannot match that filter. No-model has no assistant entry,
 * so its generation ID supplies its boundary. All IDs share one allocation order. */
async function details(tx: Tx, metadata: ExtensionHost['metadata'], task: Generation) {
  const generations: Generation[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanTasks(
      { conversationId: task.conversationId, kind: GenerationTask.definition.name },
      500,
      cursor,
    )
    generations.push(...page.items)
    cursor = page.next
  } while (cursor)
  const index = generations.findIndex((candidate) => candidate.id === task.id)
  const previous = generations.findLastIndex(
    (candidate) => candidate.id < task.id && failed(candidate),
  )
  const { upper, assistant } = await boundary(tx, task, generations[index + 1])
  const lower =
    previous < 0 ? 0 : (await boundary(tx, generations[previous], generations[previous + 1])).upper
  let step = 'model request'
  cursor = undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: task.conversationId, maxEntryId: upper as EntryId },
      100,
      cursor,
    )
    for (const entry of page.items) {
      const message = entry.model?.[0]
      const call =
        message?.role === 'assistant' &&
        message.content.findLast((part) => part.type === 'toolCall')
      if (call && call.type === 'toolCall') {
        step = call.name
        break
      }
    }
    cursor = page.next
  } while (cursor && step === 'model request')
  const title = (await tx.doc(metadata, task.conversationId)).title ?? 'Untitled'
  return { upper, lower, step, assistant, title }
}

export default function watchdog(host: ExtensionHost) {
  const Watchdog = defineTask<
    Failure & {
      failedTask: number
      recipient: ConversationId
      temporary: boolean
      until: number
      /** The model the failed run answered on, when the error is a limit a backup model may take. */
      backup?: { model: string }
    },
    // `wait`: the start of the conversation's wait on its primary (`ModelsApi.limitWait`) this retry sleeps for.
    { phase: 'wait' } | { phase: 'retry'; wait?: number } | { phase: 'report' },
    null
  >({
    name: 'watchdog.failure',
    version: 1,
    // A limit a backup may take continues again after a retry: each continuation needs a switch to an untried backup.
    initial: (input) => ({
      phase: input.temporary && (!input.retried || input.backup) ? 'wait' : 'report',
    }),
    phases: {
      wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.until, { phase: 'retry' }, ctx),
      retry: async (task, runtime, ctx) => {
        const { conversation, failedTask, error, backup } = task.input
        const child = (await runtime.conversation(conversation as ConversationId, ctx))!
        const seen = task.state.status === 'running' ? task.state.checkpoint : undefined
        const waited = seen?.phase === 'retry' ? seen.wait : undefined
        // Decided and submitted in one commit, so a conclusion cannot slip in between.
        await runtime.commit(async (tx) => {
          // A replay after submit must finish, not mistake its own retry for someone else's recovery.
          if (await tx.submissionByRequest(child.id, `watchdog-retry:${failedTask}`))
            return terminal
          // No backup could take the limit, so the conversation waits on its primary (extensions/backup): continue it
          // there once the wait is over, not before. A wait that ended meanwhile (the primary answered, a pick, a
          // failure that gave up) leaves nothing to continue.
          const wait = await host.want(ModelsApi)?.limitWait(tx, child.id)
          if (waited !== undefined && wait?.since !== waited) return terminal
          if (wait && runtime.now() < wait.until)
            return {
              status: 'sleeping',
              until: wait.until,
              checkpoint: { phase: 'retry', wait: wait.since },
            } as const
          // Every failure during a wait sleeps until its end: one of them continues the conversation per try.
          const requestId = wait
            ? `watchdog-wait:${child.id}:${wait.since}:${wait.attempt}`
            : `watchdog-retry:${failedTask}`
          if (wait && (await tx.submissionByRequest(child.id, requestId))) return terminal
          if ((await tx.doc(LiveDoc, child.id)).run !== undefined) return terminal
          // A backup model takes the failed model's place only if the definition has one for this limit; without that
          // switch the conversation still runs on the model that refused, so there is nothing to continue on.
          const model = backup && (await tx.doc(AgentDoc, child.id)).model
          const switched =
            !backup || !!wait || (!!model && `${model.provider}/${model.modelId}` !== backup.model)
          // Concluded since it failed: a retry would resume its tree, so the failure is reported (as a note) instead.
          if (!switched || (await host.need(ConversationsApi).concludedTreeIn(tx, child.id)))
            return { status: 'running', checkpoint: { phase: 'report' } } as const
          // @ultimate's wait says so once: its later tries, and the backups a try asks, run on the context as it is, so a
          // day of tries adds no message to it (Pi leaves the failed answers out, so it still ends in what is owed). Only
          // @ultimate: a subagent's report and a branch's final answer reach their parent or starter only as the answer
          // to an input (subagents' `recover`, messages' `board.route`), so they get one per run.
          const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === child.id
          const trying = !wait && (await host.want(ModelsApi)?.backup(tx, child.id))?.wait
          if (ultimate && (trying || (wait && wait.attempt > 1)))
            await child.submit(tx, { type: 'continue', requestId })
          else
            await child.submit(tx, {
              type: 'input',
              content: `Your previous run stopped with a provider error (${error}). Continue from where you left off; check what you already did and do not redo it.`,
              requestId,
              whenBusy: 'followUp',
            })
          return terminal
        }, ctx)
      },
      report: async (task, runtime, ctx) => {
        const { conversation, title, error, step, hint, retried, failedTask, recipient } =
          task.input
        const data: Failure = {
          conversation,
          title,
          error,
          step,
          retried,
          ...(hint ? { hint } : {}),
        }
        const content = `[run failed] #${conversation} "${title}": ${error}. Last step: ${step}.${retried ? ' After one automatic retry.' : ''}${hint ? ` ${hint}.` : ''}`
        if (recipient === conversation) {
          // Notices are process-local diagnostics, not submissions; a reopened facet retains no old notice.
          host.notice(content)
        } else {
          const target = (await runtime.conversation(recipient, ctx))!
          await host.harness().commit(
            async (tx) =>
              target.submit(
                tx,
                await host.need(ConversationsApi).resultIn(tx, recipient, {
                  type: 'input',
                  content: `${content}\nCheck the conversation; resume it with a message, or tell the user if it needs them.`,
                  entry: { kind: 'watchdog.failure', data },
                  requestId: `watchdog-report:${failedTask}`,
                  whenBusy: 'steer',
                }),
              ),
            ctx,
          )
        }
        await runtime.commit(async (tx) => {
          const reported = await tx.doc(Reported, ROOT_CONVERSATION_ID)
          // Newest first by when the run failed: reports of older failures can finish later.
          reported.failures.push({
            ...data,
            at: task.input.until - (task.input.backup ? BACKUP_RETRY_AFTER : RETRY_AFTER),
          })
          reported.failures.sort((a, b) => b.at - a.at)
          reported.failures.splice(FAILURE_LIMIT)
          // Reporting ends the watchdog's hold on a subagent's provider failure: its action has given up.
          await host.want(SubagentsApi)?.giveUp(tx, recipient, conversation as ConversationId)
          return terminal
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })

  async function detect(
    task: TaskRecord<JsonValue, JsonValue, JsonValue>,
    inputs?: SubmissionRecord[],
  ) {
    if (!failed(task)) return
    let submissions = inputs
    if (!submissions) {
      submissions = []
      let cursor: Cursor | undefined
      do {
        const page = await host.scanSubmissions(
          { conversationId: task.conversationId, status: 'unanswered' },
          500,
          cursor,
          context,
        )
        submissions.push(...page.items.filter(failedInput))
        cursor = page.next
      } while (cursor)
    }
    await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      if (task.id <= (receipts.highWater ?? Infinity) || receipts.tasks[String(task.id)]) return
      const info = await details(tx, host.metadata, task)
      const runInputs = submissions.filter(
        (input) =>
          failedInput(input) &&
          input.entry !== undefined &&
          (inputs !== undefined || (input.entry > info.lower && input.entry <= info.upper)),
      )
      receipts.tasks[String(task.id)] = true
      const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
      if (
        runInputs.some((input) => {
          const match = /^board:(\d+)$/.exec(input.requestId ?? '')
          return (
            match && messages.some((message) => message.id === Number(match[1]) && message.reply)
          )
        })
      )
        return
      const child = (await tx.conversation(task.conversationId))!
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      const recipient = child.owner?.conversationId ?? ultimate
      if (recipient === undefined)
        throw new Error('Watchdog needs @ultimate to report a failed run')
      if (task.state.status !== 'terminal' || task.state.outcome.status !== 'failed') return
      const error = task.state.outcome.error.message
      const { hint, temporary } = diagnose(error, info.assistant)
      // A limit Pi did not retry ended the run on the model that answered it, and the commit that recorded that answer may
      // have switched the conversation to a backup model of its definition: only a new input continues it there. `retry`
      // waits for that commit and reads the model the conversation runs on then. Without a backup to switch to, the
      // failure reports at once, as before.
      const refused = info.assistant && `${info.assistant.provider}/${info.assistant.model}`
      // A conversation that waits on its primary continues when the wait is over, whichever limit ended this run: a
      // compaction whose summary no model could write puts it in that wait before failing it, also on a retry (#207552).
      const wait = limited(error) ? await host.want(ModelsApi)?.limitWait(tx, child.id) : undefined
      const backup = wait
        ? { model: refused ?? `${wait.primary.provider}/${wait.primary.modelId}` }
        : refused &&
            limited(error) &&
            !temporary &&
            // Any backup list will do: one whose only backup refused too puts the conversation in a wait on its primary.
            !!(await host.want(Pin)?.definition(tx, child.id))?.fallback?.length
          ? { model: refused }
          : undefined
      await tx.createTask(
        Watchdog,
        {
          failedTask: task.id,
          conversation: child.id,
          recipient,
          title: info.title,
          error,
          step: info.step,
          ...(hint ? { hint } : {}),
          retried: runInputs.some((input) => input.requestId?.startsWith('watchdog-retry:')),
          ...(backup ? { backup } : {}),
          temporary: temporary || backup !== undefined,
          until: (task.endedAt ?? Date.now()) + (backup ? BACKUP_RETRY_AFTER : RETRY_AFTER),
        },
        { conversationId: recipient, ownership: { kind: 'conversation' }, background: true },
      )
    }, context)
  }

  let unsubscribe: (() => void) | undefined
  let recovery = Promise.resolve()
  const close = async () => {
    unsubscribe?.()
    unsubscribe = undefined
    await recovery
  }
  host.onClose(close)
  host.onRelease(close)
  host.implement(WatchdogApi, {
    failures: async (since) =>
      (
        (await host.harness().snapshot(Reported, ROOT_CONVERSATION_ID, context))?.failures ?? []
      ).filter((failure) => failure.at >= since),
  })
  host.onOpen(async () => {
    unsubscribe?.()
    unsubscribe = onCommit(host.harness(), (publication) => {
      const inputs = publication.changes.flatMap((change) =>
        change.type === 'submission' && failedInput(change.value) ? [change.value] : [],
      )
      for (const change of publication.changes) {
        if (change.type !== 'task' || !failed(change.value)) continue
        recovery = recovery
          .then(() =>
            detect(
              change.value,
              inputs.filter((input) => input.conversationId === change.value.conversationId),
            ),
          )
          .catch((error: unknown) => host.notice(`Watchdog recovery failed: ${String(error)}`))
      }
    })
    const tasks = await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      if (receipts.highWater === undefined) {
        let newest = 0
        let unfinished = Infinity
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanTasks({}, 500, cursor)
          for (const task of page.items) {
            newest = task.id
            if (task.state.status !== 'terminal') unfinished = Math.min(unfinished, task.id)
            // Terminal failures are historical even when a still-running older task holds the mark back.
            if (failed(task)) receipts.tasks[String(task.id)] = true
          }
          cursor = page.next
        } while (cursor)
        receipts.highWater = unfinished === Infinity ? newest : unfinished - 1
        return []
      }
      const all = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ order: 'descending' }, 500, cursor)
        all.push(...page.items.filter((task) => task.id > receipts.highWater!))
        cursor = (page.items.at(-1)?.id ?? 0) > receipts.highWater ? page.next : undefined
      } while (cursor)
      return all.toReversed()
    }, context)
    for (const task of tasks) await detect(task)
    // Do not pass unfinished tasks: an older run can fail after a newer one, even across restart.
    await host.harness().commit(async (tx) => {
      const receipts = await tx.doc(Receipts, ROOT_CONVERSATION_ID)
      for (const task of tasks) {
        if (task.state.status !== 'terminal') break
        receipts.highWater = task.id
      }
    }, context)
  })
  return defineExtension({
    name: 'watchdog',
    tasks: [Watchdog],
    hooks: [
      hook(GenerationTask, {
        beforeInput: async (_input, { tx, conversationId }) =>
          (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate === conversationId
            ? idleNote(tx, host, conversationId, Date.now())
            : undefined,
      }),
    ],
  })
}
