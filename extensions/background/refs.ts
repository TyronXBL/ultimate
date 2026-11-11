/** The result delivered to the caller and rendered as a background command card. */
export type BackgroundResult = {
  command: string
  cwd: string
  /**
   * `not-started`: it waited for RAM above the floor (`memory.minAvailableMiB`), alone or at the head of the heavy-work
   * queue, and gave up.
   */
  outcome: 'finished' | 'timeout' | 'lost' | 'not-started'
  exitCode: number | null
  /** How long it ran; for `not-started`, how long it waited. */
  seconds: number
  /** How long it waited in line for the heavy-work slot before it started, when it did. */
  queued?: number
  tail: string
  /** Empty when it never started. */
  log: string
  /** Why part of the command's process group may still run, and what to check. */
  note?: string
}
