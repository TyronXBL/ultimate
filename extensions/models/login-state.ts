/**
 * The login flow's state machine, written only here: running (with the prompt it waits on, if any), then one of
 * complete, cancelled or failed. Pure: the server stores what `transition` returns, the dialog reads `phaseOf`.
 * Browser-safe.
 */
import type { LoginFlow, LoginPhase } from './refs.ts'

export type LoginEvent<Prompt> =
  | { type: 'prompt'; prompt: Prompt }
  /** The pending prompt was answered, or aborted with the flow. */
  | { type: 'answered' }
  | { type: 'complete' }
  /** Aborted by the user, a closed dialog, or a restart that left the flow without its process. */
  | { type: 'cancel' }
  /** The provider rejected the login; its error may hold secrets, so the flow only says it failed. */
  | { type: 'fail' }

/** The phase after `event`. A finished flow ignores late events: a prompt's cleanup can land after the finish. */
export function transition<Prompt>(
  phase: LoginPhase<Prompt>,
  event: LoginEvent<Prompt>,
): LoginPhase<Prompt> {
  if (phase.state !== 'running') return phase
  if (event.type === 'prompt') return { state: 'running', prompt: event.prompt }
  if (event.type === 'answered') return { state: 'running' }
  if (event.type === 'complete') return { state: 'complete' }
  if (event.type === 'cancel') return { state: 'cancelled' }
  return { state: 'failed', error: 'Login failed' }
}

/**
 * What the dialog shows: the flow's phase, `failed` when starting it failed, and running before its document
 * arrives.
 */
export const phaseOf = (flow: LoginFlow | undefined, startError?: string): LoginPhase =>
  startError ? { state: 'failed', error: startError } : (flow?.phase ?? { state: 'running' })
