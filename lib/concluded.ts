/**
 * Whether a conversation is concluded, one derivation and two writers over the keys the UI state document keeps. Browser-safe.
 *
 * `ext.conversations.concluded` lists the concluded ids; `concludedAt` stamps when each was last concluded and is kept on
 * resume, so what a conversation reported before then stays settled.
 */
import type { JsonValue } from '@earendil-works/chord/json'

export const concludedKeys = {
  ids: 'ext.conversations.concluded',
  at: 'ext.conversations.concludedAt',
} as const

/** `active`: never concluded; `resumed`: concluded before, `at` is when it last was. */
export type Concluded =
  | { state: 'active' }
  | { state: 'concluded' }
  | { state: 'resumed'; at: number }

type Keyed = Readonly<Record<string, unknown>>

/** The concluded ids as stored, ignoring anything that is not a list of numbers. */
export function concludedIds(ui: Keyed): number[] {
  const ids = ui[concludedKeys.ids]
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []
}

function stamps(ui: Keyed): Record<string, unknown> {
  const at = ui[concludedKeys.at]
  return at && typeof at === 'object' && !Array.isArray(at) ? (at as Record<string, unknown>) : {}
}

/** Where conversation `id` stands. */
export function concludedOf(ui: Keyed, id: number): Concluded {
  if (concludedIds(ui).includes(id)) return { state: 'concluded' }
  const stamp = stamps(ui)[id]
  return typeof stamp === 'number' ? { state: 'resumed', at: stamp } : { state: 'active' }
}

/** Conclude `ids` at `now` in `ui`; concluding again re-stamps. */
export function conclude(ui: Record<string, JsonValue>, ids: readonly number[], now: number) {
  ui[concludedKeys.ids] = [...new Set([...concludedIds(ui), ...ids])]
  ui[concludedKeys.at] = {
    ...(stamps(ui) as Record<string, JsonValue>),
    ...Object.fromEntries(ids.map((id) => [id, now])),
  }
}

/** Resume `ids` in `ui`, keeping their stamps; returns the ones that were concluded. */
export function resume(ui: Record<string, JsonValue>, ids: ReadonlySet<number>) {
  const concluded = concludedIds(ui)
  const removed = concluded.filter((id) => ids.has(id))
  if (removed.length) ui[concludedKeys.ids] = concluded.filter((id) => !ids.has(id))
  return removed
}
