/**
 * Where a branch stands between its first input and its landing, the one rule the sidebar, the idea board and Review
 * read it by. Browser-safe; structural types, since lib/ imports no extension.
 */

/** A landing: the target moved from `base` to `sha` at `at` (ms); `tip` is the commit the branch submitted. */
export type BranchLanding = { sha: string; base?: string; tip?: string; at?: number }

/** The lander's index as standing reads it (the workspaces extension's `WorkspaceIndex`). */
type LanderIndex = {
  queue: readonly { conversationId: number; state: 'queued' | 'landing' }[]
  results: Readonly<
    Record<
      string,
      {
        outcome: 'landed' | 'failed'
        conversationId?: number
        sha?: string
        base?: string
        tip: string
        steps?: readonly { at: number }[]
        at?: number
      }
    >
  >
}

/** A root's landing note (lineage's `RootEvent` of type `landed`): which branch landed what, and when. */
type LandingNote = { from?: number; sha: string; base?: string; at?: number }

/**
 * Branch `id`'s latest known landing: the newest of the lander's landed results, which it keeps only for the latest
 * submissions, and the roots' landing notes, the one record of landings older than those.
 */
export function latestLanding(
  id: number,
  index: Pick<LanderIndex, 'results'>,
  notes: readonly LandingNote[],
): BranchLanding | undefined {
  let latest: BranchLanding | undefined
  const take = (landing: BranchLanding) => {
    if (!latest || (landing.at ?? 0) > (latest.at ?? 0)) latest = landing
  }
  // A result knows more of a landing than its note: the tip the branch submitted.
  const known = new Set<string>()
  for (const result of Object.values(index.results))
    if (result.conversationId === id && result.outcome === 'landed' && result.sha) {
      known.add(result.sha)
      const at = result.steps?.at(-1)?.at ?? result.at
      take({
        sha: result.sha,
        tip: result.tip,
        ...(result.base === undefined ? {} : { base: result.base }),
        ...(at === undefined ? {} : { at }),
      })
    }
  for (const note of notes)
    if (note.from === id && !known.has(note.sha))
      take({
        sha: note.sha,
        ...(note.base === undefined ? {} : { base: note.base }),
        ...(note.at === undefined ? {} : { at: note.at }),
      })
  return latest
}

/**
 * - `submitted`, `landing`: it waits in the lander's queue, or the lander lands it now;
 * - `landed`: it landed since its latest input and has no work under way;
 * - `waits`: it landed like that, but a question of it still waits on the user, so it stays in flight until answered;
 * - `concluded`: the user concluded it without a landing since its latest input;
 * - `in-flight`: everything else: it works, got input since its latest landing, or never landed.
 */
export type Standing = 'in-flight' | 'submitted' | 'landing' | 'landed' | 'waits' | 'concluded'

/**
 * Where branch `branch.id` stands, and its latest known landing (also when it is in flight again). `busy`: work of it
 * or of a subagent below it is under way (`lib/activity.ts`); `asks`: a question of it waits on the user; `inputAt` its
 * latest input (ms). `notes` are the roots' landing notes.
 */
export function branchStanding(
  branch: { id: number; inputAt?: number; busy: boolean; concluded: boolean; asks: boolean },
  index: LanderIndex,
  notes: readonly LandingNote[],
): { state: Standing; landing?: BranchLanding } {
  const landing = latestLanding(branch.id, index, notes)
  const at = (state: Standing) => (landing ? { state, landing } : { state })
  const queued = index.queue.find((item) => item.conversationId === branch.id)
  if (queued) return at(queued.state === 'landing' ? 'landing' : 'submitted')
  if (!branch.busy && landing && (landing.at ?? 0) >= (branch.inputAt ?? 0))
    return at(branch.asks ? 'waits' : 'landed')
  return at(branch.concluded ? 'concluded' : 'in-flight')
}
