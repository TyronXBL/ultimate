/**
 * Tailscale in the browser: whether this server is published on the user's tailnet, and the action that tries again
 * after fixing what blocked it. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** What blocks the publication; each carries a `hint` saying how to fix it. */
export type Problem =
  | 'not-installed'
  | 'not-running'
  | 'not-operator'
  | 'https-disabled'
  | 'port-conflict'
  | 'error'

/**
 * The publication state. `allow` is the tailnet logins allowed in (`tailscale.allow` in settings, by default the
 * tailnet's owner). `ready` carries the tailnet `url`, and a `hint` while no one can open it yet; a problem carries
 * the `hint` that fixes it. `state.ts` is the only writer.
 */
export type Status =
  | { state: 'disabled' | 'starting'; allow: string[] }
  | { state: 'ready'; url: string; allow: string[]; hint?: string }
  | { state: Problem; allow: string[]; hint: string }

/** No arguments → this server's publication status. */
export const StatusAction = actionRef<null, Status>('tailscale', 'status', { global: true })
/** No arguments → the status reached after starting the publication again; a ready one stays as it is. */
export const RetryAction = actionRef<null, Status>('tailscale', 'retry')
