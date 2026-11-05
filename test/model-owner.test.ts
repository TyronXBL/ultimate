import { expect, it } from 'vitest'
import { ownerStep, waitsForLogin } from '../extensions/models/owner.ts'
import type { ModelEvent } from '../extensions/models/owner.ts'
import type { ModelOwner } from '../extensions/models/refs.ts'

const sol = 'openai-codex/gpt-6.1-sol'
const pick: ModelEvent = {
  type: 'pick',
  model: { provider: 'faux', modelId: 'faux-1' },
  thinkingLevel: 'off',
}
const wait = (from: string): ModelEvent => ({ type: 'login-wait', from })
const switched = (reason: 'same' | 'pin' | 'default'): ModelEvent => ({
  type: 'login-fallback',
  from: 'openrouter/gone',
  to: { provider: 'faux', modelId: 'faux-1' },
  reason,
})
const waiting: ModelOwner = { by: 'login-wait', from: sol, under: { by: 'user' } }
const record = {
  primary: { provider: 'faux', modelId: 'faux-1' },
  to: { provider: 'faux', modelId: 'faux-2' },
  since: 10,
  tried: ['faux/faux-1'],
  reason: 'rate limit',
}
const backup: ModelOwner = { by: 'backup', ...record, under: { by: 'default' } }

it.each<{ row: string; from: ModelOwner; event: ModelEvent; after: ModelOwner; asked?: string }>([
  { row: 'a pick is the user’s', from: { by: 'default' }, event: pick, after: { by: 'user' } },
  {
    row: 'a pick answers the question about a lost login',
    from: waiting,
    event: pick,
    after: { by: 'user' },
  },
  ...(['same', 'pin', 'default'] as const).map((reason) => ({
    row: `a switch to the ${reason} model owns it, over a pick`,
    from: { by: 'user' } as ModelOwner,
    event: switched(reason),
    after: { by: 'login-fallback', from: 'openrouter/gone', reason } as ModelOwner,
  })),
  {
    row: 'a subscription with nothing to replace it keeps its model and asks',
    from: { by: 'user' },
    event: wait(sol),
    after: waiting,
    asked: sol,
  },
  // fa6830aa: a subscription that cannot switch says so once, not at every next input.
  {
    row: 'asking again about the same model stays asked once',
    from: waiting,
    event: wait(sol),
    after: waiting,
    asked: sol,
  },
  {
    row: 'another model without a login is asked about anew, over the owner the first wait found',
    from: waiting,
    event: wait('claude-code/opus'),
    after: { by: 'login-wait', from: 'claude-code/opus', under: { by: 'user' } },
    asked: 'claude-code/opus',
  },
  ...(
    [
      [{ by: 'default' }, { by: 'default' }],
      [{ by: 'user' }, { by: 'user' }],
      [
        { by: 'login-fallback', from: 'gone', reason: 'same' },
        { by: 'login-fallback', from: 'gone', reason: 'same' },
      ],
    ] as const
  ).map(([from, under]) => ({
    row: `backup keeps ${from.by} underneath`,
    from: from as ModelOwner,
    event: { type: 'backup', record } as ModelEvent,
    after: { by: 'backup', ...record, under } as ModelOwner,
  })),
  {
    row: 'a chained backup keeps the first owner',
    from: backup,
    event: {
      type: 'backup',
      record: { ...record, to: { provider: 'faux', modelId: 'faux-3' } },
    },
    after: { ...backup, ...record, to: { provider: 'faux', modelId: 'faux-3' } },
  },
  {
    row: 'return restores owner under backup',
    from: backup,
    event: { type: 'return' },
    after: backup.under,
  },
  {
    row: 'a creator’s model replaces a backup a fork inherited',
    from: { ...backup, under: { by: 'user' } },
    event: { type: 'start', model: { provider: 'faux', modelId: 'faux-3' } },
    after: { by: 'default' },
  },
  {
    row: 'a pick on backup makes the user owner',
    from: backup,
    event: pick,
    after: { by: 'user' },
  },
  {
    row: 'login fallback replaces backup',
    from: backup,
    event: switched('same'),
    after: { by: 'login-fallback', from: 'openrouter/gone', reason: 'same' },
  },
  {
    row: 'login wait can retain backup underneath',
    from: backup,
    event: wait(sol),
    after: { by: 'login-wait', from: sol, under: backup },
    asked: sol,
  },
  // #147838 review: a wait for a backup's login hid the backup, so the cooldown never returned to the primary.
  {
    row: 'return during a wait for a backup’s login restores the owner under the backup',
    from: { by: 'login-wait', from: sol, under: backup },
    event: { type: 'return' },
    after: backup.under,
  },
  {
    row: 'a backup during a wait for a backup’s login chains without nesting',
    from: { by: 'login-wait', from: sol, under: backup },
    event: {
      type: 'backup',
      record: { ...record, to: { provider: 'faux', modelId: 'faux-3' } },
    },
    after: { ...backup, to: { provider: 'faux', modelId: 'faux-3' } },
  },
  {
    row: 'a switch ends the wait',
    from: waiting,
    event: switched('default'),
    after: { by: 'login-fallback', from: 'openrouter/gone', reason: 'default' },
  },
])('model owner: $row', ({ from, event, after, asked }) => {
  const next = ownerStep(structuredClone(from), event)
  expect(next).toEqual(after)
  expect(waitsForLogin(next)).toBe(asked)
})
