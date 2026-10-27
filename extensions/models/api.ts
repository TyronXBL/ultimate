/**
 * Models: the model and thinking pickers and provider logins in the composer, and the `models.pin` point through which
 * a conversation finds the model and backup models its agent definition sets. Core tier.
 */
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { FallbackModel } from '../../lib/agents.ts'
export { LoginChanged } from './refs.ts'
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
export const tier = 'core'
