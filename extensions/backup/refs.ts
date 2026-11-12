/** Backup models in the browser: the switch a conversation records, and the entries it leaves. Browser-safe. */
import type { BackupRecord, WaitRecord } from '../models/refs.ts'
import { docRef } from '../../shared/extension-api.ts'

/** A model a conversation runs on. */
export type ModelRef = { provider: string; modelId: string }

/**
 * A conversation's backup as backup decides it: `primary` while it runs on its own model, else the record the model owner
 * keeps (`models.owner`): `backup` on a backup model, `waiting` on its primary after a limit no backup could take, until
 * it tries it again. Stored only in `backup.state` from before backups were an owner state.
 */
export type BackupState =
  | { kind: 'primary' }
  | ({ kind: 'backup' } & BackupRecord)
  | ({ kind: 'waiting' } & WaitRecord)

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

/** A backup model the conversation could not move to, and why: `tried` in this chain, `no login`, `too small`. */
export type Skipped = { model: string; why: string }

/**
 * The card in the conversation where a wait began: no backup could take the limit `reason` (`error` as Pi recorded it)
 * that `from` answered, so it waits for `primary` from `since`, first until `until`; `skipped` says why each backup was
 * not taken. The card reads the live wait from `models.owner` for later tries.
 */
export type BackupWait = {
  from: string
  primary: string
  reason: string
  error: string
  since: number
  until: number
  skipped: Skipped[]
}

/**
 * The line in @ultimate's transcript: which conversation switched to which model, and why; or, with `until`, that it
 * waits for its primary `to` until then; or, with `resumed`, that its wait since `since` ended with an answer of that
 * model. One line when a wait starts and one when it ends, none for its tries.
 */
export type BackupNotice =
  | { conversation: number; from: string; to: string; reason: string; until?: number }
  | { conversation: number; resumed: string; since: number }

/** The divider where a conversation returned to its primary: the backup it leaves and the model it goes back to. */
export type BackupReturned = { from: string; to: string }

/** `backup.state`, kept only to move records from before backups were an owner state into `models.owner`. */
export const BackupDoc = docRef<BackupState>('backup.state')
