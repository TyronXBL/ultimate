export type AgentOrigin = {
  body: string
  agent: string
  failed?: boolean
  sender: number
  entry?: number
  kind: 'instruction' | 'report'
  /** A report placed as a note, which woke nobody: the child still waited on its own job, or the parent was concluded. */
  note?: 'waiting' | 'concluded'
}
