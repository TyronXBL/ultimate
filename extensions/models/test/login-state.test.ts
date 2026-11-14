import { expect, it } from 'vitest'
import { transition } from '../login-state.ts'
import type { LoginEvent } from '../login-state.ts'
import type { LoginPhase } from '../refs.ts'

const prompt = { message: 'Paste the code' }

it.each<[string, LoginPhase<typeof prompt>, LoginEvent<typeof prompt>, LoginPhase<typeof prompt>]>([
  [
    'a prompt waits',
    { state: 'running' },
    { type: 'prompt', prompt },
    { state: 'running', prompt },
  ],
  [
    'an answer clears the prompt',
    { state: 'running', prompt },
    { type: 'answered' },
    { state: 'running' },
  ],
  ['the flow completes', { state: 'running', prompt }, { type: 'complete' }, { state: 'complete' }],
  ['the user cancels', { state: 'running', prompt }, { type: 'cancel' }, { state: 'cancelled' }],
  // The provider's error may hold secrets: the phase never carries it.
  [
    'the provider rejects',
    { state: 'running' },
    { type: 'fail' },
    { state: 'failed', error: 'Login failed' },
  ],
  // A prompt's cleanup can land after the finish.
  [
    'a late answer after completing',
    { state: 'complete' },
    { type: 'answered' },
    { state: 'complete' },
  ],
  [
    'a late prompt after cancelling',
    { state: 'cancelled' },
    { type: 'prompt', prompt },
    { state: 'cancelled' },
  ],
  [
    'a late cancel after failing',
    { state: 'failed', error: 'Login failed' },
    { type: 'cancel' },
    { state: 'failed', error: 'Login failed' },
  ],
])('login transition: %s', (_name, from, event, to) => {
  expect(transition(from, event)).toEqual(to)
})
