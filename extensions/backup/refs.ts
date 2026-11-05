/** Backup models in the browser: the switch a conversation records, and the entries it leaves. Browser-safe. */
import type { BackupRecord } from '../models/refs.ts'
import { docRef } from '../../shared/extension-api.ts'

/** A model a conversation runs on. */
export type ModelRef = { provider: string; modelId: string }

export type { BackupRecord } from '../models/refs.ts'

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

export type LegacyBackupState = { kind: 'primary' } | ({ kind: 'backup' } & BackupRecord)
/** `backup.state`, retained only to migrate hosts that have not recorded `models.owner` yet. */
export const BackupDoc = docRef<LegacyBackupState>('backup.state')
