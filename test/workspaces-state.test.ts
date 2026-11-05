import { expect, it } from 'vitest'
import { reconcileWorkspace, workspaceStep } from '../extensions/workspaces/state.ts'
import type { CheckoutFacts, WorkspaceEvent } from '../extensions/workspaces/state.ts'
import type { Workspace } from '../extensions/workspaces/types.ts'

const at = { path: '/w/1', branch: 'ultimate/1', base: 'b0', source: '/src', target: 'main' }
const preparing: Workspace = { ...at, state: 'preparing' }
const ready: Workspace = { ...at, state: 'ready', landed: 'l1' }
const keptReady: Workspace = { ...at, state: 'ready', landed: 'l1', error: 'remove refused' }
const failed: Workspace = { ...at, state: 'failed', error: 'setup exited 1' }
const releasing: Workspace = { ...at, state: 'releasing', landed: 'l1' }
const removed: Workspace = { ...at, state: 'removed', landed: 'l1' }
const leftBehind: Workspace = { ...at, state: 'removed', landed: 'l1', error: 'branch -D failed' }

// Strict equality: a state must not carry another state's keys, not even undefined ones.
const steps: [string, Workspace, WorkspaceEvent, Workspace][] = [
  ['preparation readies the checkout', preparing, { type: 'prepared' }, { ...at, state: 'ready' }],
  [
    'preparation fails with its error',
    preparing,
    { type: 'failed', error: 'setup exited 1' },
    failed,
  ],
  ['only a preparing record is prepared', removed, { type: 'prepared' }, removed],
  ['only a preparing record fails', ready, { type: 'failed', error: 'x' }, ready],
  [
    'recreating drops the landing',
    removed,
    { type: 'recreate', base: 'b1' },
    { ...at, base: 'b1', state: 'preparing' },
  ],
  [
    'retrying a failed setup drops its error',
    failed,
    { type: 'recreate', base: 'b1' },
    { ...at, base: 'b1', state: 'preparing' },
  ],
  ['release keeps the landing', ready, { type: 'release' }, releasing],
  ['release drops an earlier removal error', keptReady, { type: 'release' }, releasing],
  ['release of a failed setup', failed, { type: 'release' }, { ...at, state: 'releasing' }],
  ['release again finishes a removed one', removed, { type: 'release' }, releasing],
  ['a preparing record is never released', preparing, { type: 'release' }, preparing],
  ['the removal finishes', releasing, { type: 'removed' }, removed],
  ['discarding a ready checkout', ready, { type: 'removed' }, removed],
  [
    'discarding a failed setup drops its error',
    failed,
    { type: 'removed' },
    { ...at, state: 'removed' },
  ],
  [
    'a removal that left something behind',
    releasing,
    { type: 'removed', error: 'branch -D failed' },
    leftBehind,
  ],
  ['a preparing record is never removed', preparing, { type: 'removed' }, preparing],
  ['found work keeps the checkout ready', releasing, { type: 'kept' }, ready],
  ['returning to ready clears an earlier error', leftBehind, { type: 'kept' }, ready],
  [
    'a refused removal keeps its reason',
    releasing,
    { type: 'kept', error: 'remove refused' },
    keptReady,
  ],
  ['a preparing record is never kept', preparing, { type: 'kept' }, preparing],
  ['a landing', { ...at, state: 'ready' }, { type: 'landed', sha: 'l1' }, ready],
  ['a later landing replaces it', ready, { type: 'landed', sha: 'l2' }, { ...ready, landed: 'l2' }],
  [
    'a landing reported after release',
    releasing,
    { type: 'landed', sha: 'l2' },
    { ...releasing, landed: 'l2' },
  ],
  [
    'a landing reported after removal',
    removed,
    { type: 'landed', sha: 'l2' },
    { ...removed, landed: 'l2' },
  ],
  ['no landing on a checkout being prepared', preparing, { type: 'landed', sha: 'l2' }, preparing],
  ['no landing on a failed setup', failed, { type: 'landed', sha: 'l2' }, failed],
]
it.each(steps)('%s', (_name, from, event, expected) => {
  expect(workspaceStep(from, event)).toStrictEqual(expected)
})

const disk = (present: boolean, registered: boolean, held: boolean): CheckoutFacts => ({
  present,
  registered,
  held,
})
const reconciled: [
  string,
  Workspace,
  CheckoutFacts,
  string | undefined,
  WorkspaceEvent | undefined,
][] = [
  ['a present ready checkout', ready, disk(true, true, false), undefined, undefined],
  [
    'a ready checkout gone from disk owes removal',
    ready,
    disk(false, false, false),
    undefined,
    { type: 'release' },
  ],
  ['a removal finished', releasing, disk(false, false, false), undefined, { type: 'removed' }],
  ['a removal still owed', releasing, disk(true, true, false), undefined, undefined],
  ['a removed one stays removed', removed, disk(false, false, false), undefined, undefined],
  // 723cdc1f: an interrupted removal that finds new work restores the checkout.
  [
    'work found in a releasing checkout',
    releasing,
    disk(true, true, true),
    undefined,
    { type: 'kept' },
  ],
  [
    'work found in a removed checkout',
    removed,
    disk(true, true, true),
    undefined,
    { type: 'kept' },
  ],
  // b78c2a29: an unregistered leftover folder is no checkout to make ready, even while a descendant keeps it.
  ['a held unregistered leftover', removed, disk(true, false, true), undefined, undefined],
  ['a held ready checkout gone from disk', ready, disk(false, false, true), undefined, undefined],
  ['a held failed setup', failed, disk(true, true, true), undefined, undefined],
  [
    'a preparing checkout is its task’s',
    preparing,
    disk(false, false, false),
    undefined,
    undefined,
  ],
  ['a failed setup without a folder', failed, disk(false, false, false), undefined, undefined],
  // a555132e: a refused removal restores ready with its reason.
  [
    'a refused removal of a registered checkout',
    releasing,
    disk(true, true, false),
    'remove refused',
    { type: 'kept', error: 'remove refused' },
  ],
  // 9a14e554: once the folder is gone a failed branch deletion stays removed, so reuse recreates it.
  [
    'a failed cleanup after the folder went',
    releasing,
    disk(false, false, false),
    'branch -D failed',
    { type: 'removed', error: 'branch -D failed' },
  ],
]
it.each(reconciled)('reconcile: %s', (_name, workspace, facts, failure, event) => {
  expect(reconcileWorkspace(workspace, facts, failure)).toStrictEqual(event)
})
