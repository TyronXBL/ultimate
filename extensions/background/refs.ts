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
  tail: string
  /** Empty when it never started. */
  log: string
  /** Why part of the command's process group may still run, and what to check. */
  note?: string
}
