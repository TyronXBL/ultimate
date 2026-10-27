/**
 * Backup: the point at which a failure on a limited model switches its conversation to a backup model, for work that
 * reports a failure without going through the answer it recorded. Optional: `want` it.
 */
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'

export type BackupService = {
  /**
   * Move conversation `id` off the model that answered `message` with a rate limit, capacity or quota error into the
   * next backup model of its agent definition. Once per failed entry, so a failure reported twice leaves one switch;
   * true when the conversation runs on a backup because of that failure, now or by an earlier switch.
   */
  fallBack(id: ConversationId, message: AssistantMessage, entry: EntryId): Promise<boolean>
}
/** The backup switch; `want` it, backup is optional. */
export const BackupApi = defineApi<BackupService>()('backup')
