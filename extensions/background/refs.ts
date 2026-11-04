/** The result delivered to the caller and rendered as a background command card. */
export type BackgroundResult = {
  command: string
  cwd: string
  /** `not-started`: it waited for RAM above the floor (`memory.minAvailableMiB`) and gave up. */
  outcome: 'finished' | 'timeout' | 'lost' | 'not-started'
  exitCode: number | null
  seconds: number
  tail: string
  /** Empty when it never started. */
  log: string
  /** Why part of the command's process group may still run, and what to check. */
  note?: string
}
