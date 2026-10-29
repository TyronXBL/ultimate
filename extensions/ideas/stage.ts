import type { Idea } from './refs.ts'

/** The board's columns, in order; Parked is folded away. */
export type Column = 'ideas' | 'assessing' | 'building' | 'landed' | 'parked'

export const columns: { id: Column; label: string }[] = [
  { id: 'ideas', label: 'Ideas' },
  { id: 'assessing', label: 'Assessing' },
  { id: 'building', label: 'Building' },
  { id: 'landed', label: 'Landed' },
  { id: 'parked', label: 'Parked' },
]

/** What the board knows of a launched idea's branch, read live. */
export type BranchFacts = {
  /** It landed since its latest input, with the landed commit and the target tip it moved from. */
  landed?: { sha: string; base?: string; at?: number }
  /** The user concluded it. */
  concluded: boolean
  /** It is in the lander's queue. */
  submitted: boolean
  /** It started building: a plan epic, or commits not yet on its target. */
  started: boolean
}

/**
 * Where an idea stands: its column, and why when the column alone does not say it (`launching` until @ultimate links
 * its branch, `not built` for a branch concluded without landing).
 */
export function stageOf(
  idea: Idea,
  branch: BranchFacts | undefined,
): { column: Column; note?: 'launching' | 'not built' } {
  if (idea.parked !== undefined) return { column: 'parked' }
  if (!idea.launch) return { column: 'ideas' }
  const size = idea.launch.size === 'build' ? 'building' : 'assessing'
  if (idea.launch.branch === undefined) return { column: size, note: 'launching' }
  if (branch?.landed) return { column: 'landed' }
  if (branch?.concluded) return { column: 'parked', note: 'not built' }
  if (branch?.submitted || branch?.started) return { column: 'building' }
  return { column: size }
}
