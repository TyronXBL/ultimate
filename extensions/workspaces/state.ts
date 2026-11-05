/**
 * A conversation's workspace as a state machine. `Workspace` (types.ts) is a union on `state`, each state carrying only
 * its fields; `workspaceStep` is the only writer of them, `reconcileWorkspace` turns what is on disk into the event to
 * apply, and readers narrow on `state` or use `released` and `lastLanded`. Browser-safe.
 */
import type { Workspace } from './types.ts'

/** What changes a workspace. */
export type WorkspaceEvent =
  /** Its preparation made the checkout and ran setup. */
  | { type: 'prepared' }
  /** Its preparation failed or was aborted. */
  | { type: 'failed'; error: string }
  /** Preparation starts again, at `base`. */
  | { type: 'recreate'; base: string }
  /** Removing the checkout is decided and owed. */
  | { type: 'release' }
  /** The checkout is gone; `error` says what its removal could not finish. */
  | { type: 'removed'; error?: string }
  /** The checkout stays usable; `error` says why its removal failed. */
  | { type: 'kept'; error?: string }
  /** Its work landed at `sha`. */
  | { type: 'landed'; sha: string }

/** What is on disk for a record's checkout. */
export type CheckoutFacts = {
  /** Its folder exists. */
  present: boolean
  /** The source lists it as a worktree. */
  registered: boolean
  /** It holds what release must keep: uncommitted changes, commits only it has, or a live checkout sourced from it. */
  held: boolean
}

/** Whether the checkout is released or being released: the conversation recreates it before using it again. */
export const released = (workspace: Workspace) =>
  workspace.state === 'releasing' || workspace.state === 'removed'

/** The tip the checkout's last landing brought, if one did. */
export const lastLanded = (workspace: Workspace) =>
  'landed' in workspace ? workspace.landed : undefined

function checkout({ path, branch, base, source, target }: Workspace) {
  return { path, branch, base, source, target }
}
const landed = (workspace: Workspace) => {
  const sha = lastLanded(workspace)
  return sha === undefined ? {} : { landed: sha }
}
const error = (reason: string | undefined) => (reason === undefined ? {} : { error: reason })

/**
 * The workspace after `event`; an event that does not apply to its state leaves it unchanged. Preparation alone ends a
 * preparing record. Leaving for ready, releasing or removed keeps `landed` and drops an earlier error; recreating
 * starts over without either. A landing is recorded only on a checkout that was ready for it.
 */
export function workspaceStep(workspace: Workspace, event: WorkspaceEvent): Workspace {
  const preparing = workspace.state === 'preparing'
  switch (event.type) {
    case 'prepared':
      return preparing ? { ...checkout(workspace), state: 'ready' } : workspace
    case 'failed':
      return preparing ? { ...checkout(workspace), state: 'failed', error: event.error } : workspace
    case 'recreate':
      return { ...checkout(workspace), base: event.base, state: 'preparing' }
    case 'release':
      return preparing
        ? workspace
        : { ...checkout(workspace), state: 'releasing', ...landed(workspace) }
    case 'removed':
      return preparing
        ? workspace
        : { ...checkout(workspace), state: 'removed', ...landed(workspace), ...error(event.error) }
    case 'kept':
      return preparing
        ? workspace
        : { ...checkout(workspace), state: 'ready', ...landed(workspace), ...error(event.error) }
    case 'landed':
      return preparing || workspace.state === 'failed'
        ? workspace
        : { ...workspace, landed: event.sha }
    default:
      return event satisfies never
  }
}

/**
 * The event that brings the record in line with its checkout on disk, after a removal attempt that failed with
 * `failure` if one did. A failed removal leaves the checkout ready while the source still registers it, else removed.
 * Work a released checkout holds makes it ready again, if registered; a ready record whose folder is gone owes a
 * removal; a releasing one whose checkout is gone is removed.
 */
export function reconcileWorkspace(
  workspace: Workspace,
  disk: CheckoutFacts,
  failure?: string,
): WorkspaceEvent | undefined {
  if (failure !== undefined) return { type: disk.registered ? 'kept' : 'removed', error: failure }
  if (disk.held) return disk.registered && released(workspace) ? { type: 'kept' } : undefined
  switch (workspace.state) {
    case 'ready':
      return disk.present ? undefined : { type: 'release' }
    case 'releasing':
      return disk.present || disk.registered ? undefined : { type: 'removed' }
    case 'preparing':
    case 'failed':
    case 'removed':
      return undefined
    default:
      return workspace satisfies never
  }
}

/** Apply `event` to record `id` of a document draft's items, writing only a changed record. */
export function advanceWorkspace(
  items: Record<string, Workspace>,
  id: number | string,
  event: WorkspaceEvent | undefined,
) {
  const key = String(id)
  const next = event ? workspaceStep(items[key], event) : items[key]
  if (next !== items[key]) items[key] = next
  return next
}
