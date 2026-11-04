/** The publication state's one transition and the one view of it every reader uses. Browser-safe, pure. */
import type { Problem, Status } from './refs.ts'

export type Event =
  | { type: 'starting' }
  /** The allowlist is known (settings, else the tailnet's owner) while the start goes on. */
  | { type: 'resolved'; allow: string[] }
  /** Served at `url`; an `allow` of undefined means status did not list the owner's login yet. */
  | { type: 'published'; url: string; allow?: string[] }
  /** A later status read listed the owner's login. */
  | { type: 'owner-found'; allow: string[] }
  | { type: 'blocked'; problem: Problem; hint: string }
  | { type: 'stopped' }

const noOwner =
  'No one can open it yet: tailscale status --json does not list the owner login (Self.UserID in User). It is read again on the next tailnet request.'

export const off: Status = { state: 'disabled', allow: [] }

export function transition(status: Status, event: Event): Status {
  switch (event.type) {
    case 'starting':
      return { state: 'starting', allow: [] }
    case 'resolved':
      return { state: 'starting', allow: event.allow }
    case 'published':
      return event.allow
        ? { state: 'ready', url: event.url, allow: event.allow }
        : { state: 'ready', url: event.url, allow: [], hint: noOwner }
    case 'owner-found':
      return status.state === 'ready'
        ? { state: 'ready', url: status.url, allow: event.allow }
        : status
    case 'blocked':
      return { state: event.problem, allow: status.allow, hint: event.hint }
    case 'stopped':
      return { state: 'disabled', allow: status.allow }
    default:
      return event satisfies never
  }
}

/** A status that blocks the publication and says how to fix it. */
export function isProblem(status: Status): status is Extract<Status, { state: Problem }> {
  return status.state !== 'disabled' && status.state !== 'starting' && status.state !== 'ready'
}

/** What the status line and the details show: nothing yet, the address, or a fix to make. */
export function view(
  status: Status | undefined,
): 'loading' | 'off' | 'starting' | 'ready' | 'trouble' {
  if (!status) return 'loading'
  if (isProblem(status)) return 'trouble'
  return status.state === 'disabled' ? 'off' : status.state
}
