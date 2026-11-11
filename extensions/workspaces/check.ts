/**
 * How one run of a lander check settles into its result. A check may reuse an earlier pass of exactly the commit it
 * checks instead of testing again (the project's CI gate does, #205147): it then prints a `REUSED` line naming that
 * run, and the landing card shows it beside the checks that ran.
 */
import type { LanderCheck, Reused } from './types.ts'

/** A check prints this, then one JSON object (`Reused`), when it passed by reusing an earlier run of the same commit. */
export const REUSED = 'lander-reused: '

/** What one run of a check gave: its failure, else its last output line and the last reuse line it printed. */
export type CheckRun = { failure?: string; summary?: string; reused?: string }

const short = (sha: string) => sha.slice(0, 7)

/** The origin a reuse line names, or undefined when it does not name a complete one. */
function originOf(line: string): Reused | undefined {
  let value: unknown
  try {
    value = JSON.parse(line.slice(REUSED.length))
  } catch {
    // Not JSON: it names no origin, which the caller reports as such.
    return undefined
  }
  const { runner, url, sha, completedAt, seconds } = (value ?? {}) as Partial<
    Record<keyof Reused, unknown>
  >
  if (
    typeof runner !== 'string' ||
    !runner ||
    typeof url !== 'string' ||
    !/^https?:\/\//.test(url) ||
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    typeof seconds !== 'number' ||
    !(seconds >= 0)
  )
    return undefined
  return { runner, url, sha, completedAt, seconds }
}

/**
 * The only writer of a check's result, from one run of `command` on commit `sha`. A first run passes, reuses or fails;
 * the rerun after a failure is flaky or fails again. A reuse counts only when it names its run and that run tested
 * `sha` itself; otherwise the check failed, since nothing tested this commit. A rerun never passes by reuse: an earlier
 * pass cannot outweigh the failure this commit just had.
 */
export function settleCheck(
  command: string,
  attempt: 'first' | 'rerun',
  run: CheckRun,
  sha: string,
): { check: LanderCheck; failure?: string } {
  const failed = (failure: string) => ({ check: { command, result: 'failed' as const }, failure })
  if (run.failure !== undefined) return failed(run.failure)
  const summary = run.summary ? { summary: run.summary } : {}
  if (run.reused !== undefined) {
    const reused = originOf(run.reused)
    if (!reused) return failed(`it claimed a reused pass without naming its run: ${run.reused}`)
    if (reused.sha !== sha)
      return failed(
        `it reused a pass of ${short(reused.sha)}, not of ${short(sha)}, the commit it checks: ${reused.url}`,
      )
    if (attempt === 'rerun')
      return failed(
        `its rerun only reused an earlier pass (${reused.url}); after a failure on ${short(sha)} it must run again`,
      )
    return { check: { command, result: 'reused', reused, ...summary } }
  }
  return { check: { command, result: attempt === 'first' ? 'passed' : 'flaky', ...summary } }
}

/** "GitHub Actions passed 1a2b3c4 in 198 s, finished <time>: <url>": a reused pass's origin, for reports and cards. */
export const reusedText = (reused: Reused, time: (at: number) => string) =>
  `${reused.runner} passed ${short(reused.sha)} in ${reused.seconds} s, finished ${time(reused.completedAt)}: ${reused.url}`
