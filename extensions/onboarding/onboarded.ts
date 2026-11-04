/**
 * Whether onboarding ran for this project: it started for the root (`onboarding.starts`), or the root carries
 * memories, which only setup writes first; a new chapter's root starts without `onboarding.starts` but keeps them.
 */
export const onboarded = (
  started: number | undefined,
  memories: { memories: Record<string, unknown> } | null,
) => started !== undefined || Object.keys(memories?.memories ?? {}).length > 0

/**
 * Where the first run stands: `off` when the user's settings say `"onboarding": false`, else `done` once the marker
 * file exists, else `pending`. Every reader derives it here; `server.ts` writes the marker.
 */
export type FirstRun = 'pending' | 'done' | 'off'
export const firstRunOf = (off: boolean, marked: boolean): FirstRun =>
  off ? 'off' : marked ? 'done' : 'pending'

/**
 * Whether the first-run dialog shows: reopened from ⌘K Get ready… (whatever the first run's state), as the first run
 * itself until the user finishes or skips it, or not at all.
 */
export const firstRunView = (
  reopened: boolean,
  pending: boolean,
  finished: boolean,
): 'closed' | 'reopened' | 'first-run' =>
  reopened ? 'reopened' : pending && !finished ? 'first-run' : 'closed'
