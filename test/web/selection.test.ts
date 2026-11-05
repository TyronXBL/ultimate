import { describe, expect, it } from 'vitest'
import { step } from '../../web/src/sdk/selection.ts'
import type { Selection } from '../../web/src/sdk/selection.ts'

const start: Selection = { phase: 'starting' }
const following: Selection = { phase: 'following', selected: 1, entry: 'push' }
const redirected = step(following, { type: 'redirect' }).state
const rows = [
  [
    'start without URL id',
    start,
    { type: 'started', id: undefined },
    { phase: 'following', selected: undefined, entry: 'push' },
    [{ type: 'show', id: undefined }],
  ],
  [
    // The first URL write replaces the entry the page loaded on; the next selection is the user going somewhere.
    'start with URL id replaces, then pushes',
    start,
    { type: 'started', id: 1 },
    { phase: 'following', selected: 1, entry: 'push' },
    [
      { type: 'url', id: 1, replace: true },
      { type: 'show', id: 1 },
    ],
  ],
  [
    'follow a new id pushes',
    following,
    { type: 'selected', id: 2 },
    { phase: 'following', selected: 2, entry: 'push' },
    [
      { type: 'url', id: 2, replace: false },
      { type: 'show', id: 2 },
    ],
  ],
  [
    'follow same id still shows',
    following,
    { type: 'selected', id: 1 },
    { phase: 'following', selected: 1, entry: 'push' },
    [{ type: 'show', id: 1 }],
  ],
  [
    'redirect then follow replaces',
    redirected,
    { type: 'selected', id: 2 },
    { phase: 'following', selected: 2, entry: 'push' },
    [
      { type: 'url', id: 2, replace: true },
      { type: 'show', id: 2 },
    ],
  ],
  [
    'back to the same id writes no URL',
    redirected,
    { type: 'selected', id: 1 },
    { phase: 'following', selected: 1, entry: 'push' },
    [{ type: 'show', id: 1 }],
  ],
  [
    'fallback then root never writes an undefined URL',
    redirected,
    { type: 'selected', id: undefined },
    { phase: 'following', selected: undefined, entry: 'push' },
    [{ type: 'show', id: undefined }],
  ],
  [
    'shown canonicalizes and resets entry',
    { phase: 'following', selected: 2, entry: 'replace' },
    { type: 'shown', id: 2 },
    { phase: 'following', selected: 2, entry: 'push' },
    [{ type: 'url', id: 2, replace: true }],
  ],
  ['events before start are ignored', start, { type: 'redirect' }, start, []],
] as const

describe('conversation selection transitions', () => {
  it.each(rows)('%s', (_name, state, event, expected, effects) => {
    expect(step(state, event)).toEqual({ state: expected, effects })
  })
})
