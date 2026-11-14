/**
 * Where a command ran, on a machine whose project has a remote runner (`lib/remote-job.ts`): on the runner's host, with
 * what getting it there cost and the CPU time it used there (`timings`, absent when it ran out of time there); here,
 * because the project does not run that command remotely; or here after the runner gave no result, and why.
 */
export type RanWhere =
  | {
      kind: 'remote'
      host: string
      timings?: { transferSeconds: number; setupSeconds: number; cpuSeconds: number }
    }
  | { kind: 'here' }
  | { kind: 'here-after'; host: string; reason: string }

/** The result delivered to the caller and rendered as a background command card. */
export type BackgroundResult = {
  command: string
  cwd: string
  /**
   * `not-started`: it waited for RAM above the floor (`memory.minAvailableMiB`), alone or at the head of the heavy-work
   * queue, and gave up. `stopped`: the heavy-work queue ended it, as `note` says.
   */
  outcome: 'finished' | 'timeout' | 'lost' | 'not-started' | 'stopped'
  exitCode: number | null
  /** How long it ran; for `not-started`, how long it waited. */
  seconds: number
  /** How long it waited in line for the heavy-work slot before it started, when it did. */
  queued?: number
  /**
   * What it used in its own systemd scope (`lib/job-scope.ts`): peak memory, CPU time, its memory limit and whether the
   * kernel killed part of it at that limit. Absent where jobs run without a scope, or when it was stopped.
   */
  usage?: { peakMiB: number; cpuSeconds: number; limitMiB: number; oomKilled: boolean }
  /** Where it ran; absent where the project has no remote runner on this machine, and for one that never started. */
  where?: RanWhere
  tail: string
  /** Empty when it never started. */
  log: string
  /** Why part of the command's process group may still run, and what to check. */
  note?: string
}
