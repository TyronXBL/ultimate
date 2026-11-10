import { expect, it } from 'vitest'
import { familyIn, ownerStep, waitsForLogin } from '../owner.ts'
import type { ModelEvent } from '../owner.ts'
import type { ModelOwner } from '../refs.ts'

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
const limitRecord = {
  primary: { provider: 'faux', modelId: 'faux-1' },
  since: 20,
  until: 80,
  attempt: 1,
  tried: ['faux/faux-1', 'faux/faux-2'],
  reason: 'quota',
}
const limitWait: ModelOwner = { by: 'limit-wait', ...limitRecord, under: { by: 'user' } }

it.each<{
  row: string
  from: ModelOwner
  event: ModelEvent
  after: ModelOwner
  asked?: string
  family?: string
}>([
  { row: 'a pick is the user’s', from: { by: 'default' }, event: pick, after: { by: 'user' } },
  // #550837: two families can share a model, so the one a conversation runs as is recorded, never worked out.
  {
    row: 'a pick by family runs as that family',
    from: { by: 'default', family: 'lead' },
    event: { ...pick, family: 'design' },
    after: { by: 'user', family: 'design' },
    family: 'design',
  },
  {
    row: 'a pick by id runs as no family',
    from: { by: 'user', family: 'lead' },
    event: pick,
    after: { by: 'user' },
  },
  {
    row: 'a creator names the family it starts on',
    from: { by: 'user' },
    event: { type: 'start', model: { provider: 'faux', modelId: 'faux-1' }, family: 'lead' },
    after: { by: 'default', family: 'lead' },
    family: 'lead',
  },
  {
    row: 'a login fallback runs as no family',
    from: { by: 'default', family: 'lead' },
    event: switched('pin'),
    after: { by: 'login-fallback', from: 'openrouter/gone', reason: 'pin' },
  },
  {
    row: 'a wait for a login keeps the family of the model it keeps',
    from: { by: 'default', family: 'lead' },
    event: wait(sol),
    after: { by: 'login-wait', from: sol, under: { by: 'default', family: 'lead' } },
    asked: sol,
    family: 'lead',
  },
  {
    row: 'the return from a backup brings the family underneath back',
    from: { by: 'backup', ...record, under: { by: 'default', family: 'lead' } },
    event: { type: 'return' },
    after: { by: 'default', family: 'lead' },
    family: 'lead',
  },
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
  {
    row: 'a wait for the primary after the last backup keeps the owner under the backup',
    from: { ...backup, under: { by: 'user' } },
    event: { type: 'wait', record: limitRecord },
    after: limitWait,
  },
  {
    row: 'a longer wait keeps the first owner',
    from: limitWait,
    event: { type: 'wait', record: { ...limitRecord, until: 200, attempt: 2 } },
    after: { ...limitWait, until: 200, attempt: 2 },
  },
  {
    row: 'a backup taken after a wait keeps the first owner',
    from: limitWait,
    event: { type: 'backup', record },
    after: { by: 'backup', ...record, under: { by: 'user' } },
  },
  {
    row: 'the primary’s answer, or giving up, returns to the owner under the wait',
    from: limitWait,
    event: { type: 'return' },
    after: { by: 'user' },
  },
  {
    row: 'a pick during a wait is the user’s, and nothing restores the wait',
    from: { by: 'limit-wait', ...limitRecord, under: { by: 'default' } },
    event: pick,
    after: { by: 'user' },
  },
  {
    row: 'a creator’s model replaces a wait',
    from: limitWait,
    event: { type: 'start', model: { provider: 'faux', modelId: 'faux-3' } },
    after: { by: 'default' },
  },
])('model owner: $row', ({ from, event, after, asked, family }) => {
  const next = ownerStep(structuredClone(from), event)
  expect(next).toEqual(after)
  expect(waitsForLogin(next)).toBe(asked)
  expect(familyIn(next)).toBe(family)
})
