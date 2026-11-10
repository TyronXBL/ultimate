import { expect, it } from 'vitest'
import { standingOf } from '../../item.ts'
import type { UpdateState } from '../../refs.ts'

const state = (extra: Partial<UpdateState> = {}): UpdateState => ({
  root: '/clone',
  behind: 0,
  commits: [],
  install: false,
  restart: false,
  ...extra,
})
const layers = { core: false, bin: false, lockfile: false, live: true }
const updatedWith = (changed: Partial<typeof layers>) => ({
  ok: true as const,
  from: 'a',
  to: 'b',
  commits: 1,
  layers: { ...layers, ...changed },
  install: 'skipped' as const,
})
const none = { hold: 'none' } as const

// What the item and the popover show, from the facts one refresh collects.
const standings: [string, Partial<UpdateState>, object][] = [
  ['a preview shows nothing', { preview: true }, { kind: 'preview' }],
  ['a current clone', {}, { kind: 'current', ...none }],
  // An update that touched only hot-reloading code owes nothing: current again, with what it did.
  [
    'a hot-only update',
    { updated: updatedWith({}) },
    { kind: 'current', ...none, updated: updatedWith({}) },
  ],
  ['new commits', { behind: 3 }, { kind: 'behind', ...none }],
  [
    'new commits an update would refuse',
    { behind: 3, refused: 'dirty' },
    { kind: 'behind', hold: 'refused', reason: 'dirty' },
  ],
  [
    'a diverged clone @ultimate can merge',
    { behind: 3, ahead: 1, refused: 'main has diverged', merge: true },
    { kind: 'behind', hold: 'merge' },
  ],
  ['an install owed', { install: true }, { kind: 'install', ...none }],
  // fe5907cd: server/ changed in HEAD since boot, nothing installed, nothing behind.
  ['a restart owed', { restart: true }, { kind: 'restart', reload: true, ...none }],
  [
    'a core update',
    { updated: updatedWith({ core: true }) },
    { kind: 'restart', reload: true, ...none, updated: updatedWith({ core: true }) },
  ],
  [
    'a bin update, which a restart does not load',
    { updated: updatedWith({ bin: true }) },
    { kind: 'restart', reload: false, ...none, updated: updatedWith({ bin: true }) },
  ],
  // Behind wins over everything owed; an install over a restart.
  [
    'new commits while a restart is owed',
    { behind: 1, restart: true },
    { kind: 'behind', ...none },
  ],
  ['an install and a restart owed', { install: true, restart: true }, { kind: 'install', ...none }],
  [
    'a dirty clone with nothing behind',
    { refused: 'dirty' },
    { kind: 'current', hold: 'refused', reason: 'dirty' },
  ],
]

it.each(standings)('derives %s', (_name, facts, expected) => {
  expect(standingOf(state(facts))).toEqual(expected)
})
