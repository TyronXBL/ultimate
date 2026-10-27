/** Backup models in the browser: the switch a conversation records, and the entries it leaves. Browser-safe. */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { docRef } from '../../shared/extension-api.ts'

/** A model a conversation runs on. */
export type ModelRef = { provider: string; modelId: string }

/**
 * One switch away from the primary, so the next limit can switch again from there: the model and thinking level the
 * conversation runs on otherwise, the backup it runs on now and since when, and the models it already left.
 */
export type BackupRecord = {
  primary: ModelRef
  thinking?: ModelThinkingLevel
  to: ModelRef
  /** When it switched (ms); a run that starts its cooldown later puts the primary back. */
  since: number
  /** The models switched away from, `provider/modelId`, so a chain of limits tries each backup once. */
  tried: string[]
}

/** The backup a conversation runs on: `backup.state`, on that conversation. Unset while it runs on its primary. */
export type BackupState = Partial<BackupRecord>

/**
 * The card in the conversation that switched: the model that answered with the limit, the backup it runs on now, which
 * limit, the error as Pi recorded it, and the minutes until it returns to the primary.
 */
export type BackupSwitch = {
  from: string
  to: string
  reason: string
  error: string
  cooldown: number
}

/** The line in @ultimate's transcript: which conversation switched to which model, and why. */
export type BackupNotice = { conversation: number; from: string; to: string; reason: string }

/** The divider where a conversation returned to its primary: the backup it leaves and the model it goes back to. */
export type BackupReturned = { from: string; to: string }

/** The backup, on the conversation that runs on one. */
export const BackupDoc = docRef<BackupState>('backup.state')
