/** Dream in the browser: the prepared next chapter, the sleep into it and the chapters. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * What @ultimate prepared for the next chapter once its dream's work was done: the chapter's name, three lines it
 * learned, and its handover, which the new chapter wakes up from.
 */
export type Prepared = { chapter: string; learned: string[]; handoff: string; at: number }

export type Backup = { id?: string; skipped?: string }

/** A sleep as the cards show it, derived from the journey. `asleep`: the switch happened; this chapter is the one it left. */
export type Sleep =
  | { phase: 'seeding' | 'backing up' | 'switching'; chapter: string; backup?: Backup; at: number }
  | { phase: 'failed'; chapter: string; backup?: Backup; error: string; at: number }
  | { phase: 'asleep'; chapter: string; at: number }

/** The latest dream: `branch`, the branch @ultimate started in the turn that answered `requested` (its `dream.requested` entry), at `at`. */
export type Dream = { branch: number; requested: number; at: number }

/**
 * The way from a dream into a fresh chapter, each state with exactly its fields; `dreamStep` (`state.ts`) is its only
 * writer. `woke`: the dream is recorded, and once its branch is concluded the user is shown Fall asleep. `preparing`:
 * they pressed it at `asked`, @ultimate prepares. `dismissed`: they chose to stay in this chapter. `prepared`: the
 * Fall asleep card waits. `sleeping`/`failed`/`asleep`: the sleep into `chapter`, which keeps the `prepared` it is for.
 * A prepared chapter keeps the `dream` it followed (none if @ultimate prepared unasked): a replayed or second branch
 * event of that dream's request must not start the journey over.
 */
export type Journey =
  | { state: 'idle' }
  | { state: 'woke'; dream: Dream }
  | { state: 'preparing'; dream: Dream; asked: number }
  | { state: 'dismissed'; dream: Dream }
  | { state: 'prepared'; prepared: Prepared; dream?: Dream }
  | {
      state: 'sleeping'
      prepared: Prepared
      chapter: string
      phase: 'seeding' | 'backing up' | 'switching'
      backup?: Backup
      at: number
      dream?: Dream
    }
  | {
      state: 'failed'
      prepared: Prepared
      chapter: string
      backup?: Backup
      error: string
      at: number
      dream?: Dream
    }
  | { state: 'asleep'; prepared: Prepared; chapter: string; at: number; dream?: Dream }

/** `{ journey }` on conversation 1: where the way into the next chapter stands. */
export const DreamDoc = docRef<{ journey: Journey }>('dream.next')

/**
 * A `dream.requested` entry in @ultimate's conversation: who asked for the dream, the user's Dream button or a
 * built-in automation (`pause`: how long the user had been away, ms).
 */
export type RequestedEntry = { automation?: { id: string; name: string; pause?: number } }

/** No arguments: ask @ultimate to dream now. User-only. */
export const StartAction = actionRef<null, { requested: true }>('dream', 'start')
/** No arguments: the user pressed Fall asleep after the dream; @ultimate is asked to prepare the chapter. User-only. */
export const ReadyAction = actionRef<null, { asked: number }>('dream', 'ready')
/** No arguments: the user stays in this chapter; the dream's Fall asleep cue goes. User-only. */
export const DismissAction = actionRef<null, { dismissed: true }>('dream', 'dismiss')
/**
 * `{ chapter, learned, handoff }`: @ultimate prepares the next chapter and puts the Fall asleep card up; a second call
 * replaces it.
 */
export const PrepareAction = actionRef<
  { chapter: string; learned: string[]; handoff: string },
  Prepared
>('dream', 'prepare')
/** `{ name? }` → progress: seed, back up and restart into the prepared chapter. User-only. */
export const AsleepAction = actionRef<{ name?: string }, { sleep: Sleep }>('dream', 'asleep')
/** No arguments → the active chapter, its number, the newest name, and every chapter in creation order. */
export const ChaptersAction = actionRef<
  null,
  {
    active: string
    number: number
    newest: string
    chapters: { name: string; number: number; createdAt?: number }[]
  }
>('dream', 'chapters', { global: true })
/** `{ chapter }`: restart into an existing, idle chapter. User-only; a returned error means restart failed. */
export const SwitchAction = actionRef<{ chapter: string }, never>('dream', 'switch')

/**
 * Calls per tool over the trace's window: how often, how often failing, how slow; and enabled tools never called. Uses
 * per skill over the same window: reads of its SKILL.md, the user's `/skill:` runs and failed ones of either; and listed
 * skills with no traced use. Bash reads are not traced; durations include waits; tool failures exclude model calls.
 */
export type ToolStats = {
  interpretation: string
  since?: number
  calls: number
  tools: { name: string; calls: number; failed: number; avgMs: number }[]
  unused: string[]
  /** The most frequent errors, each with its two newest calls: `#<conversation>/<entry>` and the start of its args. */
  errors: {
    name: string
    error: string
    count: number
    examples: { at: string; args: string }[]
  }[]
  skills: { name: string; reads: number; runs: number; failed: number }[]
  skillsWithNoTracedUse: string[]
}
/** No arguments → tool statistics from `trace.sqlite`, no model involved. */
export const StatsAction = actionRef<null, ToolStats>('dream', 'stats')
