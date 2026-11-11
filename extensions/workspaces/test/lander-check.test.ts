import { expect, it } from 'vitest'
import { REUSED, settleCheck } from '../check.ts'
import type { CheckRun } from '../check.ts'

const sha = 'a'.repeat(40)
const origin = {
  runner: 'GitHub Actions',
  url: 'https://ci.example/runs/1',
  sha,
  completedAt: 1794381000000,
  seconds: 198,
}
const claim = (value: object) => REUSED + JSON.stringify(value)

it.each<[string, 'first' | 'rerun', CheckRun, object]>([
  ['a first run that passed', 'first', { summary: 'ok' }, { result: 'passed', summary: 'ok' }],
  ['a rerun that passed', 'rerun', { summary: 'ok' }, { result: 'flaky', summary: 'ok' }],
  [
    'a first run reusing a named pass of this commit',
    'first',
    { reused: claim(origin), summary: 'ok' },
    { result: 'reused', reused: origin, summary: 'ok' },
  ],
])('settles %s as passing', (_case, attempt, run, expected) => {
  expect(settleCheck('gate', attempt, run, sha)).toEqual({
    check: { command: 'gate', ...expected },
  })
})

it.each<[string, 'first' | 'rerun', CheckRun, string]>([
  ['a run that failed', 'first', { failure: 'exit 1' }, 'exit 1'],
  ['a rerun that failed', 'rerun', { failure: 'exit 1' }, 'exit 1'],
  [
    'a reuse of another commit',
    'first',
    { reused: claim({ ...origin, sha: 'b'.repeat(40) }) },
    'it reused a pass of bbbbbbb, not of aaaaaaa',
  ],
  [
    'a reuse that names no run',
    'first',
    { reused: claim({ ...origin, url: undefined }) },
    'without naming its run',
  ],
  ['a reuse line that is not JSON', 'first', { reused: `${REUSED}{` }, 'without naming its run'],
  [
    'a rerun that only reused an earlier pass',
    'rerun',
    { reused: claim(origin) },
    'its rerun only reused an earlier pass',
  ],
])('settles %s as failed', (_case, attempt, run, failure) => {
  expect(settleCheck('gate', attempt, run, sha)).toEqual({
    check: { command: 'gate', result: 'failed' },
    failure: expect.stringContaining(failure),
  })
})
