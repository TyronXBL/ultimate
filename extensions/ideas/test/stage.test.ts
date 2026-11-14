import { expect, it } from 'vitest'
import type { Standing } from '../../../lib/standing.ts'
import type { Idea, LaunchSize } from '../refs.ts'
import { stageOf } from '../stage.ts'

const idea = (fields: Partial<Idea> = {}): Idea => ({
  id: 1,
  title: 'An idea',
  tags: [],
  by: 'user',
  at: 1,
  ...fields,
})
const launched = (size: LaunchSize, branch?: number) => idea({ launch: { size, at: 2, branch } })
const facts = (standing: Standing, started = false) => ({ standing, started })

it.each([
  ['an idea on the board', idea(), undefined, { column: 'ideas' }],
  ['a parked idea', idea({ parked: 3 }), undefined, { column: 'parked' }],
  [
    'a parked idea that was launched',
    idea({ parked: 3, launch: { size: 'build', at: 2, branch: 9 } }),
    facts('landed'),
    { column: 'parked' },
  ],
  [
    'an assessment @ultimate has not linked yet',
    launched('assess'),
    undefined,
    { column: 'assessing', note: 'launching' },
  ],
  [
    'a build @ultimate has not linked yet',
    launched('build'),
    undefined,
    { column: 'building', note: 'launching' },
  ],
  ['a linked branch not read yet', launched('assess', 9), undefined, { column: 'assessing' }],
  ['an assessment in flight', launched('assess', 9), facts('in-flight'), { column: 'assessing' }],
  [
    'an assessment that started building',
    launched('assess', 9),
    facts('in-flight', true),
    { column: 'building' },
  ],
  ['a build in flight', launched('build', 9), facts('in-flight'), { column: 'building' }],
  ['a submitted branch', launched('assess', 9), facts('submitted'), { column: 'building' }],
  ['a landing branch', launched('assess', 9), facts('landing'), { column: 'building' }],
  ['a landed branch', launched('assess', 9), facts('landed'), { column: 'landed' }],
  [
    'a landed branch waiting on the user',
    launched('build', 9),
    facts('waits', true),
    { column: 'landed' },
  ],
  [
    'a branch concluded without landing',
    launched('build', 9),
    facts('concluded', true),
    { column: 'parked', note: 'not built' },
  ],
] as const)('%s', (_case, stored, branch, stage) => {
  expect(stageOf(stored, branch)).toEqual(stage)
})
