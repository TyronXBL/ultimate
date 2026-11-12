/**
 * Conversations: titles, summaries, the summary model and concluding conversations. Other extensions read what a
 * conversation is about and ask the summary model through this service.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  InputEntry,
  InputSubmissionDraft,
  SubmissionDraft,
  Tx,
} from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { ContextDoc, MarksDoc } from './refs.ts'
import type { AgentMarkStyle, ContextUsage } from './refs.ts'
import type { ConversationSubject, KeptWork } from './types.ts'
import type {
  accountResponse,
  askSummaryModel,
  setAutomaticSummaries,
  SummaryRequest,
} from './summary.ts'
import type { SummaryModel, SummaryModelStatus } from './summary-model.ts'

/**
 * One reason conversation `id` will be woken again. Core reads its own `run` and queued `input`; every other reason comes
 * from the extension that owns the work, through a registered `UnderwaySource`, and each consumer picks the reasons it
 * counts. `delivering`: the job or notify submitted its result and has not ended yet.
 */
export type Underway =
  | { kind: 'run' }
  | { kind: 'input' }
  /** A background command or CI run of `id`'s, which wakes it with its result. */
  | { kind: 'job'; delivering: boolean }
  /** A waking `notify` of `id`'s, which wakes it when another conversation finishes. */
  | { kind: 'notify'; delivering: boolean }
  /** A subagent's report on its way to `id`, until its input is admitted. */
  | { kind: 'report' }
  /** A subagent of `id`'s, at any depth, that runs, has input queued, or awaits a report or a waking notify. */
  | { kind: 'child' }
  /** A reply-enabled message `id` sent, still waiting on its answer. */
  | { kind: 'reply' }
  /** A submission of `id`'s that the lander has queued or is reporting. */
  | { kind: 'landing' }
/** An extension's own work that will wake a conversation, registered with `registerUnderway`. */
export type UnderwaySource = {
  /** Who reports it; registering the same name again replaces the earlier source. */
  name: string
  /** Inside `tx`, the reasons this extension's work will wake `id` again; empty when none. */
  underway(tx: Tx, id: ConversationId): Promise<Underway[]>
}
export type ConversationsService = {
  /**
   * Inside `tx`, every reason `id` will be woken again: its run, its queued input and each registered source's reasons.
   * Ask it to decide whether an answer of `id`'s is final; filter the kinds that matter to you.
   */
  underway(tx: Tx, id: ConversationId): Promise<Underway[]>
  /**
   * Report an extension's waking work to `underway`; returns its removal, which leaves a newer source of the same name in
   * place. Register in `onOpen` and pass the removal to `onClose`.
   */
  registerUnderway(source: UnderwaySource): () => void
  /** What conversation `id` is about now: its title, summary and feature, for a record that outlives a retitle. */
  subject: (id: ConversationId, caller: Context) => Promise<ConversationSubject>
  /** The conversations the user concluded; use it to leave their resources (worktrees) alone or free them. */
  concluded: (caller: Context) => Promise<Set<ConversationId>>
  /** Read concluded conversations inside an existing transaction, including its pending changes. */
  concludedIn(tx: Tx): Promise<Set<ConversationId>>
  /**
   * Inside `tx`, whether `id` or a conversation above it is concluded. Any run in `id` resumes them all, so a report
   * for `id` goes in as a note instead.
   */
  concludedTreeIn(tx: Tx, id: ConversationId): Promise<boolean>
  /**
   * Inside `tx`, result `input` for `id` (a background command, CI run, notify or automation) as `id` takes it: the input,
   * or while `concludedTreeIn`, its entry as a note that starts no run. Submit what it returns in the same `tx`.
   */
  resultIn(
    tx: Tx,
    id: ConversationId,
    input: InputSubmissionDraft & { entry: InputEntry },
  ): Promise<SubmissionDraft>
  /**
   * Conclude top-level conversations `ids` inside `tx`, as the Conclude action does before it frees their resources
   * through `Release`; throws for unknown and owned conversations, roots and standing agents.
   */
  concludeIn(tx: Tx, ids: ConversationId[]): Promise<void>
  /** The summary model to ask now, from settings; undefined while none is valid and available. */
  summaryModel(): Promise<SummaryModel | undefined>
  /** The summary model with why: the configured one, a fallback for a default without a login, or why none runs. */
  summaryModelStatus(): Promise<SummaryModelStatus>
  /** Request a summary of `id` inside the trigger's transaction, with the model resolved before it. */
  requestSummary(
    tx: Tx,
    id: ConversationId,
    request: SummaryRequest,
    model: SummaryModel | undefined,
  ): Promise<void>
  /**
   * Inside `tx`, turn conversation `id`'s automatic summaries (intent, reply and spawn triggers) on or off; its title
   * then stays as set. Off for standing agents, landers, side chats and definitions with `summaries: false`.
   */
  setAutomaticSummaries: typeof setAutomaticSummaries
  /**
   * Inside `tx`, mark conversation `id` a standing agent, a fixed part of the project that is never concluded, or
   * (`false`) an ordinary conversation again. Subagents sets it on residents, workspaces on landers.
   */
  setStanding(tx: Tx, id: ConversationId, standing: boolean): Promise<void>
  /** Ask a summary model once with a system prompt and input, or return the response the receipt already holds. */
  askSummaryModel: typeof askSummaryModel
  /** Add a summary model response's usage to the conversation's `pi.usage` inside `tx`, after asking. */
  accountResponse: typeof accountResponse
  /**
   * Inside `tx`, mark `title` of a new conversation `id` (a branch or root named by its intent) as generated, so its
   * summary may replace it; a no-op once a rename or summary chose another title.
   */
  generatedTitle(tx: Tx, id: ConversationId, title: string): Promise<void>
}
export type TreesService = {
  /** The root of the tree conversation `id` belongs to, or undefined outside any tree. */
  rootOf(id: number, ctx: Context): Promise<number | undefined>
  /** The root whose tally lists top-level conversation `id`, with its branch intent; undefined for roots and others. */
  branchOf(id: number, ctx: Context): Promise<{ root: number; intent?: string } | undefined>
  /**
   * Write the abstract of conversation `id` into its tree root's tally inside `tx`, before the transaction's first
   * entry; a no-op outside a tree.
   */
  abstract(
    tx: Tx,
    id: number,
    input: { text: string; at: number; title?: string; feature?: string },
  ): Promise<void>
}
/**
 * The extension point through which summaries know a conversation's tree: a root's feature names its whole tree, and
 * a branch's summary writes its abstract into the tally. Lineage provides it.
 */
export const Trees = defineApi<TreesService>()('conversations.trees')
export type ReleaseService = {
  /** Free what concluded conversations `ids` and their owned descendants hold; returns the work kept, and why. */
  release(ids: number[], caller: Context): Promise<KeptWork[]>
}
/** The extension point concluding frees resources through; workspaces provides it (worktrees). */
export const Release = defineApi<ReleaseService>()('conversations.release')
export type PreviewsService = {
  /** Stop the previews conversations `ids` started (each listed, descendants included); returns their instance ids. */
  stop(ids: number[], caller: Context): Promise<string[]>
}
/** The extension point the Conclude action stops previews through; instance provides it. */
export const Previews = defineApi<PreviewsService>()('conversations.previews')
/**
 * How full a conversation's context is, on that conversation: the one measure the status line and automations' context
 * triggers read. The conversations extension keeps it; a fork starts empty until its first answer.
 */
export const ContextUsageDoc = defineDoc<ContextUsage>({
  kind: ContextDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ at: 0 }),
})
export type { ContextUsage } from './refs.ts'
/** How each standing agent's mark looks, on conversation 1; subagents writes it from the definitions. */
export const Marks = defineDoc<Record<string, AgentMarkStyle>>({
  kind: MarksDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** Conversation subjects and the summary model; core, so `need` it. */
export const ConversationsApi = defineApi<ConversationsService>()('conversations')
export const tier = 'core'
