/** The pinned user turn in the browser: the stored inputs it reads below the loaded history. Browser-safe. */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'

/** A page of inputs, newest first; `before` is the cursor of the next page, absent at the end. */
export type InputsPage = { entries: EntryRecord[]; before?: number }

/**
 * `{ conversation, before }` → `{ entries, before? }`: conversation `conversation`'s own inputs below entry `before`,
 * newest first, at most 64, without the entries between them and without their images. A fork's source history ends
 * the scan.
 */
export const InputsAction = actionRef<{ conversation: number; before: number }, InputsPage>(
  'pinned-turn',
  'inputs',
)
