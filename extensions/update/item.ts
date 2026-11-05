import type { UpdateResult, UpdateState } from './refs.ts'

/** How an update is held back: not at all, by a refusal, or by a divergence @ultimate can merge. */
type Hold = { hold: 'none' } | { hold: 'refused'; reason: string } | { hold: 'merge' }

/** What the popover shows besides the kind: the update this server made, and what holds the next one back. */
type Owed = Hold & { updated?: UpdateResult & { ok: true } }

/**
 * What the clone's update state shows, derived once for the status-line item, the popover and the server's merge
 * check: nothing on a preview, `behind` with new commits, `install` or `restart` while one is owed, else the quiet
 * `current`. `reload` says a restart loads the owed code; without it (only `bin/` changed) the supervisor must restart.
 */
export type Standing =
  | { kind: 'preview' }
  | (Owed & { kind: 'current' | 'behind' | 'install' })
  | (Owed & { kind: 'restart'; reload: boolean })

export function standingOf(state: UpdateState): Standing {
  if (state.preview) return { kind: 'preview' }
  const held: Hold = state.merge
    ? { hold: 'merge' }
    : state.refused
      ? { hold: 'refused', reason: state.refused }
      : { hold: 'none' }
  if (state.behind) return { kind: 'behind', ...held }
  const updated = state.updated
  const shown = { ...held, ...(updated ? { updated } : {}) }
  if (state.install) return { kind: 'install', ...shown }
  // Another Ultimate on the clone may have updated it: `restart` and `install` come from the clone, not this server.
  const reload =
    state.restart || Boolean(updated && (updated.layers.core || updated.layers.lockfile))
  if (reload || updated?.layers.bin) return { kind: 'restart', reload, ...shown }
  return { kind: 'current', ...shown }
}
