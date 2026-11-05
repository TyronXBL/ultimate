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
