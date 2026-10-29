/** One job of a run: its name, conclusion and seconds from start to end. */
export type JobResult = { name: string; conclusion: string; seconds?: number }
/** A failing test (Vitest's `file > test` annotation title) or a failed job without one, with its first error line. */
export type Failure = { title: string; message: string }

/** The data of a `ci.result` entry: one CI run's outcome, as its card shows it. */
export type CiResult = {
  sha: string
  /** The `ci/` ref it ran on, deleted once the run ended. */
  ref?: string
  /** The Actions run. */
  url?: string
  /** `refused`: the secret scan stopped the push; `no-run`: no run started; `unreachable`: GitHub failed. */
  conclusion: 'success' | 'failure' | 'cancelled' | 'refused' | 'no-run' | 'unreachable'
  /** First job start to last job end. */
  seconds?: number
  jobs: JobResult[]
  failures: Failure[]
  /** Why it did not run, or a note on a run that did. */
  reason?: string
}
