import type { Tool } from '@earendil-works/pi-mcp'
import type { McpServerStatus } from './refs.ts'

const FIRST_RETRY = 5_000
const LAST_RETRY = 5 * 60_000

/**
 * One server's connection. `attempts` counts the failures in a row (a success resets it). An invalid entry in the
 * settings never connects.
 */
export type Connection =
  | { state: 'invalid'; error: string }
  | { state: 'connecting'; attempts: number }
  | { state: 'connected'; tools: Tool[] }
  | {
      state: 'failed'
      error: string
      /** The `${NAME}` secret its last connect could not find. */
      missing?: string
      retryAt: number
      attempts: number
    }

export type ConnectionEvent =
  /** A first connect or a scheduled retry: the failures so far count on. */
  | { type: 'connect' }
  /** A reconnect on request or after a broken call: starts again from no failures. */
  | { type: 'restart' }
  | { type: 'connected'; tools: Tool[] }
  /** The server's tool list changed while connected. */
  | { type: 'tools'; tools: Tool[] }
  | { type: 'failed'; error: string; missing?: string; now: number }

const attemptsOf = (connection: Connection) =>
  connection.state === 'connecting' || connection.state === 'failed' ? connection.attempts : 0

/** The only writer of a server's connection: its next state, with the backoff for a failure computed here. */
export function advance(connection: Connection, event: ConnectionEvent): Connection {
  switch (event.type) {
    case 'connect':
      return { state: 'connecting', attempts: attemptsOf(connection) }
    case 'restart':
      return { state: 'connecting', attempts: 0 }
    case 'connected':
      return { state: 'connected', tools: event.tools }
    case 'tools':
      return connection.state === 'connected' ? { ...connection, tools: event.tools } : connection
    case 'failed': {
      const attempts = attemptsOf(connection) + 1
      return {
        state: 'failed',
        error: event.error,
        ...(event.missing ? { missing: event.missing } : {}),
        retryAt: event.now + Math.min(FIRST_RETRY * 2 ** (attempts - 1), LAST_RETRY),
        attempts,
      }
    }
    default:
      return event satisfies never
  }
}

/** What the status line and panel show of a connection. */
export function statusOf(
  connection: Connection,
): Pick<McpServerStatus, 'state' | 'tools' | 'error' | 'missing' | 'retryAt'> {
  switch (connection.state) {
    case 'invalid':
      return { state: 'failed', error: connection.error }
    case 'connecting':
      return { state: 'connecting' }
    case 'connected':
      return { state: 'connected', tools: connection.tools.length }
    case 'failed':
      return {
        state: 'failed',
        error: connection.error,
        ...(connection.missing ? { missing: connection.missing } : {}),
        retryAt: connection.retryAt,
      }
    default:
      return connection satisfies never
  }
}
