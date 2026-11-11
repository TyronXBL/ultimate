import { expect, it } from 'vitest'
import { gatePlan, REUSE_MS, reusable } from '../.ultimate/extensions/ci/github.ts'
import type { Job, Run } from '../.ultimate/extensions/ci/github.ts'

const sha = 'c'.repeat(40)
const run = (id: number, status: string, conclusion: string | null): Run => ({
  id,
  status,
  conclusion,
  html_url: `https://ci.example/runs/${id}`,
})

it.each<[string, Run[], ReturnType<typeof gatePlan>]>([
  ['no run of the commit', [], { kind: 'fresh', why: 'no CI run of ccccccc' }],
  [
    'one pass',
    [run(1, 'completed', 'success')],
    { kind: 'reuse', run: run(1, 'completed', 'success') },
  ],
  [
    'a run still in progress beside a pass',
    [run(2, 'in_progress', null), run(1, 'completed', 'success')],
    { kind: 'wait', run: run(2, 'in_progress', null) },
  ],
  [
    'a pass beside a failed run of the same commit',
    [run(2, 'completed', 'success'), run(1, 'completed', 'failure')],
    { kind: 'fresh', why: 'tip CI had failed: https://ci.example/runs/1' },
  ],
  [
    'a cancelled run',
    [run(1, 'completed', 'cancelled')],
    { kind: 'fresh', why: 'tip CI had ended cancelled: https://ci.example/runs/1' },
  ],
])('plans the gate for %s', (_case, runs, plan) => {
  expect(gatePlan(runs, sha)).toEqual(plan)
})

const job = (started: string | null, completed: string | null): Job => ({
  id: 1,
  name: 'test',
  conclusion: 'success',
  started_at: started,
  completed_at: completed,
})
const passed = run(7, 'completed', 'success')
const end = Date.parse('2026-11-11T07:10:00Z')

it('reuses a pass by when GitHub finished its last job, with how long it took', () => {
  const jobs = [
    job('2026-11-11T07:06:42Z', '2026-11-11T07:09:00Z'),
    job('2026-11-11T07:07:00Z', '2026-11-11T07:10:00Z'),
  ]
  expect(reusable(passed, jobs, sha, end + REUSE_MS)).toEqual({
    origin: { runner: 'GitHub Actions', url: passed.html_url, sha, completedAt: end, seconds: 198 },
  })
  expect(reusable(passed, jobs, sha, end + REUSE_MS + 1)).toEqual({
    why: `the pass of ccccccc is 6 h old: ${passed.html_url}`,
  })
  expect(reusable(passed, [job('2026-11-11T07:07:00Z', null)], sha, end)).toEqual({
    why: `the pass of ccccccc has no job times: ${passed.html_url}`,
  })
})
