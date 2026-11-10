/**
 * Models: the model and thinking pickers and provider logins in the composer, and the `models.pin` point through which
 * a conversation finds the model and backup models its agent definition sets. Core tier.
 */
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { FallbackModel } from '../../lib/agents.ts'
import type { ModelEvent } from './owner.ts'
import type { BackupRecord, ModelOwner, WaitRecord } from './refs.ts'
export { LoginChanged } from './refs.ts'

export type ModelsService = {
  /** Who set conversation `id`'s model (`models.owner`), read inside `tx`. */
  owner(tx: Tx, id: ConversationId): Promise<ModelOwner>
  /** The backup conversation `id` runs on, also while it waits for that backup's login, read inside `tx`; else none. */
  backup(tx: Tx, id: ConversationId): Promise<BackupRecord | undefined>
  /** The wait on its primary conversation `id` keeps after a limit no backup could take, read inside `tx`; else none. */
  limitWait(tx: Tx, id: ConversationId): Promise<WaitRecord | undefined>
  /**
   * Inside `tx`, set conversation `id`'s model as `event` says and record who set it (`models.owner`): the one writer
   * of both, so another extension sends an event instead of assigning `agent.model`.
   */
  setModel(tx: Tx, id: ConversationId, event: ModelEvent): Promise<void>
}
/** A conversation's model and who set it; models provides it. */
export const ModelsApi = defineApi<ModelsService>()('models')
export type PinService = {
  /**
   * The definition conversation `id` runs as, read inside `tx`: the model it pins and its ordered backup models;
   * undefined without one.
   */
  definition(
    tx: Tx,
    id: ConversationId,
  ): Promise<
    { model?: { provider: string; modelId: string }; fallback?: FallbackModel[] } | undefined
  >
}
/**
 * The extension point a conversation asks for the definition its agent runs as, before it falls back to the default
 * model when its model lost its login, and when it switches to a backup model. Subagents provides it (it records
 * which definition a conversation runs as).
 */
export const Pin = defineApi<PinService>()('models.pin')

export type BackupOrderService = {
  /**
   * The models conversation `id` would move to, in order, were its model and each one after it to answer with a limit,
   * read inside `tx`. Switches nothing.
   */
  order(tx: Tx, id: ConversationId): Promise<FallbackModel[]>
}
/**
 * The extension point work that runs on a conversation's model asks where to go when that model is limited, without
 * moving the conversation: a compaction's summary. Backup provides it.
 */
export const BackupOrder = defineApi<BackupOrderService>()('models.backup-order')

export type ResetsService = {
  /**
   * When `provider`'s exhausted usage limits reset (ms), as it reports now; undefined when none is exhausted. For a
   * limit error just seen: it reads the provider's usage again.
   */
  resetsAt(provider: string): Promise<number | undefined>
}
/** The extension point that says when a provider's usage limit resets. Quota provides it. */
export const Resets = defineApi<ResetsService>()('models.resets')
export const tier = 'core'
