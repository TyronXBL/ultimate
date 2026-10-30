/** The result delivered to the caller and rendered as a background command card. */
export type BackgroundResult = {
  command: string
  cwd: string
  outcome: 'finished' | 'timeout' | 'lost'
  exitCode: number | null
  seconds: number
  tail: string
  log: string
}
