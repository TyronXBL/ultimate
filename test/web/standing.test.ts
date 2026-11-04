import { describe, expect, it } from 'vitest'
import { activityOf, isBusy } from '../../lib/activity.ts'
import { branchStanding } from '../../lib/standing.ts'
import { stageOf } from '../../extensions/ideas/stage.ts'
import { listedInFlight } from '../../extensions/sidebar/branch.tsx'
import type { Idea } from '../../extensions/ideas/refs.ts'

describe('conversation activity', () => {
  it.each([
    [{}, 'idle'],
    [{ queued: true }, 'queued'],
    [{ run: true, queued: true }, 'working'],
    [{ task: true }, 'working'],
    // A pause holds the run and the input queued behind it.
    [{ task: true, queued: true, parked: true }, 'paused'],
  ] as const)('%o is %s', (facts, activity) => {
    expect(activityOf(facts)).toBe(activity)
  })

  it('is busy while work of it is under way, also queued or paused', () => {
    expect(['paused', 'working', 'queued', 'idle'].filter((a) => isBusy(a as never))).toEqual([
      'paused',
      'working',
      'queued',
    ])
  })
})

describe('branch standing', () => {
  const id = 7
  const result = (at: number, sha = 'r1') => ({
    outcome: 'landed' as const,
    conversationId: id,
    sha,
    base: 'b0',
    tip: 't1',
    steps: [{ at }],
  })
  const branch = { id, inputAt: 100, busy: false, concluded: false, asks: false }
  const lander = (
    results = {},
    queue: { conversationId: number; state: 'queued' | 'landing' }[] = [],
  ) => ({
    queue,
    results,
  })

  it.each([
    ['never landed', branch, lander(), [], 'in-flight'],
    ['landed after its latest input', branch, lander({ s1: result(200) }), [], 'landed'],
    [
      'given input after its landing',
      { ...branch, inputAt: 300 },
      lander({ s1: result(200) }),
      [],
      'in-flight',
    ],
    // #77730: a branch asking the user and landing straight away stays in flight until they answer.
    [
      'landed while it asks the user',
      { ...branch, asks: true },
      lander({ s1: result(200) }),
      [],
      'waits',
    ],
    // b3ac73d2: queued again, an earlier landing never stands in for it.
    [
      'queued after an earlier landing',
      branch,
      lander({ s1: result(200) }, [{ conversationId: id, state: 'queued' }]),
      [],
      'submitted',
    ],
    ['being landed', branch, lander({}, [{ conversationId: id, state: 'landing' }]), [], 'landing'],
    // Only queued input, or a paused run: still under way, as its row says.
    ['busy after landing', { ...branch, busy: true }, lander({ s1: result(200) }), [], 'in-flight'],
    // The lander keeps only recent results: the root's landing note is the one record of an older landing.
    [
      'landed past the recent results',
      branch,
      lander(),
      [{ from: id, sha: 'n1', base: 'b0', at: 200 }],
      'landed',
    ],
    ["another branch's note", branch, lander(), [{ from: 8, sha: 'n1', at: 200 }], 'in-flight'],
    // 47a26d86: a concluded branch is done with, landed or not.
    ['concluded without landing', { ...branch, concluded: true }, lander(), [], 'concluded'],
    [
      'concluded after landing',
      { ...branch, concluded: true },
      lander({ s1: result(200) }),
      [],
      'landed',
    ],
  ] as const)('%s: %s', (_, facts, index, notes, state) => {
    const standing = branchStanding(facts, index, notes).state
    expect(standing).toBe(state)
    if (facts.asks) expect(listedInFlight(standing)).toBe(true)
  })

  it('knows its latest landing, a result over the note written from it', () => {
    const notes = [
      { from: id, sha: 'r1', base: 'b0', at: 250 },
      { from: id, sha: 'n0', base: 'bx', at: 50 },
    ]
    expect(branchStanding(branch, lander({ s1: result(200) }), notes).landing).toEqual({
      sha: 'r1',
      base: 'b0',
      tip: 't1',
      at: 200,
    })
    // Past the recent results, given input since: in flight again, and it still knows what it landed last.
    expect(branchStanding({ ...branch, inputAt: 300 }, lander(), notes)).toEqual({
      state: 'in-flight',
      landing: { sha: 'r1', base: 'b0', at: 250 },
    })
  })

  it("puts an idea in its branch's column", () => {
    const idea = { launch: { size: 'assess', branch: id } } as unknown as Idea
    const stage = (standing: Parameters<typeof stageOf>[1]) => stageOf(idea, standing)
    expect(stage({ standing: 'in-flight', started: false })).toEqual({ column: 'assessing' })
    // b7a9fba4: a plan, commits or an earlier landing keep it in Building, also across a reload.
    expect(stage({ standing: 'in-flight', started: true })).toEqual({ column: 'building' })
    expect(stage({ standing: 'submitted', started: false })).toEqual({ column: 'building' })
    expect(stage({ standing: 'waits', started: true })).toEqual({ column: 'landed' })
    expect(stage({ standing: 'concluded', started: true })).toEqual({
      column: 'parked',
      note: 'not built',
    })
  })
})
