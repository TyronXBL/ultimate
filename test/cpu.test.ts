import { expect, it } from 'vitest'
import {
  BASH_WINDOW_MS,
  cpuGate,
  LIGHT_FOR_MS,
  measuring,
  observe,
  PRESSURE_PCT,
  PRESSURE_WAIT_MS,
  PROBATION_MS,
} from '../lib/cpu.ts'
import type { CpuGate, CpuSample, Observation } from '../lib/cpu.ts'

const busy = { load: 27.6, cores: 6, pressure: 36 }
const calm = { load: 5.9, cores: 6, pressure: PRESSURE_PCT - 1 }
/** Nothing of the queue runs; one job runs (a place is free), long enough to show in the load. */
const idle = { running: 0, settled: true, outsideSince: 0 }
const one = { running: 1, settled: true }
const alone = { below: { load: 6, pressure: PRESSURE_PCT }, settling: false }
const beside = { below: { load: 12, pressure: undefined }, settling: false }

it.each<[string, Parameters<typeof cpuGate>, CpuGate]>([
  ['off: no limit set', [busy, undefined, 0, idle], { kind: 'go' }],
  ['load below the cores and little pressure', [calm, 1, 0, idle], { kind: 'go' }],
  [
    'load at the cores waits',
    [{ ...calm, load: 6 }, 1, 0, idle],
    { kind: 'wait', ...calm, load: 6, below: alone.below, settling: false },
  ],
  [
    'pressure waits before the load shows it (the incident: mutate 74 s after slice.sh)',
    [{ ...calm, load: 5.2, pressure: PRESSURE_PCT }, 1, 0, idle],
    {
      kind: 'wait',
      ...calm,
      load: 5.2,
      pressure: PRESSURE_PCT,
      below: alone.below,
      settling: false,
    },
  ],
  [
    "the queue's own load never forces a start",
    [busy, 1, PRESSURE_WAIT_MS * 10, one],
    { kind: 'wait', ...busy, ...beside },
  ],
  [
    'outside load waits while the bound has not passed',
    [busy, 1, PRESSURE_WAIT_MS - 1, idle],
    { kind: 'wait', ...busy, ...alone },
  ],
  [
    'outside load starts it anyway once the bound passed',
    [busy, 1, PRESSURE_WAIT_MS, idle],
    { kind: 'forced', ...busy, waited: PRESSURE_WAIT_MS },
  ],
  [
    'a second job starts beside one whose pressure fills the machine, below twice the cores',
    [{ load: 11.9, cores: 6, pressure: 40 }, 1, 0, one],
    { kind: 'go' },
  ],
  [
    'no second job beside an 8-worker test run (load 14.6 on 6 cores, #226486 at 20:36)',
    [{ load: 14.6, cores: 6, pressure: 45 }, 1, 0, one],
    { kind: 'wait', load: 14.6, cores: 6, pressure: 45, ...beside },
  ],
  [
    'no second job until the first shows in the load',
    [{ load: 2, cores: 6, pressure: 30 }, 1, 0, { ...one, settled: false }],
    { kind: 'wait', load: 2, cores: 6, pressure: 30, ...beside, settling: true },
  ],
])('gate: %s', (_name, args, gate) => {
  expect(cpuGate(...args)).toEqual(gate)
})

const at = (seconds: number, cpuSeconds: number): CpuSample => ({
  at: seconds * 1000,
  cpuMs: cpuSeconds * 1000,
})
const probe = PROBATION_MS / 1000

it.each<[string, Observation, CpuSample, Observation, boolean?]>([
  [
    'on probation until it is certain',
    measuring(0),
    at(10, 9),
    { kind: 'measuring', started: 0, last: at(10, 9) },
  ],
  [
    'heavy at once past a whole probation of CPU (the incident: vitest on 8 workers)',
    measuring(0),
    at(5, probe + 1),
    { kind: 'heavy', last: at(5, probe + 1) },
  ],
  [
    'light after probation at a core or less',
    measuring(0),
    at(probe, probe),
    { kind: 'light', last: at(probe, probe) },
  ],
  [
    'heavy after probation above a core',
    { kind: 'measuring', started: 0, last: at(15, 10) },
    at(probe + 2, probe + 3),
    { kind: 'heavy', last: at(probe + 2, probe + 3) },
  ],
  [
    'a light job above a core starts climbing',
    { kind: 'light', last: at(100, 10) },
    at(105, 20),
    { kind: 'climbing', since: 100_000, last: at(105, 20) },
  ],
  [
    'climbing for a probation turns heavy, with a place',
    { kind: 'climbing', since: 100_000, last: at(115, 40) },
    at(100 + probe, 52),
    { kind: 'heavy', last: at(100 + probe, 52) },
    true,
  ],
  [
    'climbing for a probation without a place reclaims one (a wrapper idle through its probation)',
    { kind: 'climbing', since: 100_000, last: at(115, 40) },
    at(100 + probe, 52),
    { kind: 'reclaiming', last: at(100 + probe, 52) },
  ],
  [
    'climbing that calms is light again',
    { kind: 'climbing', since: 100_000, last: at(105, 20) },
    at(110, 21),
    { kind: 'light', last: at(110, 21) },
  ],
  [
    'a heavy job below a tenth of a core starts cooling',
    { kind: 'heavy', last: at(100, 100) },
    at(110, 100.5),
    { kind: 'cooling', since: 100_000, last: at(110, 100.5) },
  ],
  [
    'cooling long enough releases its place (the knowledgebase test run idle for 50 min)',
    { kind: 'cooling', since: 100_000, last: at(150, 102) },
    at(100 + LIGHT_FOR_MS / 1000, 103),
    { kind: 'released', last: at(100 + LIGHT_FOR_MS / 1000, 103) },
  ],
  [
    'released and still quiet stays released',
    { kind: 'released', last: at(100, 10) },
    at(105, 12),
    { kind: 'released', last: at(105, 12) },
  ],
  [
    'released and busy again reclaims a place, which its owner takes or ends it for',
    { kind: 'released', last: at(100, 10) },
    at(105, 20),
    { kind: 'reclaiming', last: at(105, 20) },
  ],
  [
    'reclaiming stays so while no place is free',
    { kind: 'reclaiming', last: at(105, 20) },
    at(110, 20),
    { kind: 'reclaiming', last: at(110, 20) },
  ],
  [
    'reclaiming with a place is heavy again',
    { kind: 'reclaiming', last: at(105, 20) },
    at(110, 20),
    { kind: 'heavy', last: at(110, 20) },
    true,
  ],
  [
    'released and busy with a place free is heavy at once',
    { kind: 'released', last: at(100, 10) },
    at(105, 20),
    { kind: 'heavy', last: at(105, 20) },
    true,
  ],
  [
    'cooling that works again is heavy',
    { kind: 'cooling', since: 100_000, last: at(110, 101) },
    at(115, 110),
    { kind: 'heavy', last: at(115, 110) },
  ],
  [
    'CPU time that left the group counts as none',
    { kind: 'heavy', last: at(100, 100) },
    at(110, 40),
    { kind: 'cooling', since: 100_000, last: at(110, 40) },
  ],
])('observe: %s', (_name, before, sample, after, place = false) => {
  expect(observe(before, sample, PROBATION_MS, place)).toEqual(after)
})

it('measures a bash command over its own, longer window', () => {
  let observation: Observation = { kind: 'light', last: at(0, 0) }
  for (let seconds = 5; seconds < BASH_WINDOW_MS / 1000; seconds += 5) {
    observation = observe(observation, at(seconds, seconds * 2), BASH_WINDOW_MS, true)
    expect(observation.kind).toBe('climbing')
  }
  expect(observe(observation, at(BASH_WINDOW_MS / 1000, 60), BASH_WINDOW_MS, true).kind).toBe(
    'heavy',
  )
})
