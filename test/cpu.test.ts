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

it.each<[string, Parameters<typeof cpuGate>, CpuGate]>([
  ['off: no limit set', [busy, undefined, 0, 0], { kind: 'go' }],
  ['load below the cores and little pressure', [calm, 1, undefined, 0], { kind: 'go' }],
  [
    'load at the cores waits',
    [{ ...calm, load: 6 }, 1, undefined, 0],
    { kind: 'wait', ...calm, load: 6, limit: 1 },
  ],
  [
    'pressure waits before the load shows it (the incident: mutate 74 s after slice.sh)',
    [{ ...calm, load: 5.2, pressure: PRESSURE_PCT }, 1, undefined, 0],
    { kind: 'wait', ...calm, load: 5.2, pressure: PRESSURE_PCT, limit: 1 },
  ],
  [
    "the queue's own load never forces a start",
    [busy, 1, undefined, PRESSURE_WAIT_MS * 10],
    { kind: 'wait', ...busy, limit: 1 },
  ],
  [
    'outside load waits while the bound has not passed',
    [busy, 1, 0, PRESSURE_WAIT_MS - 1],
    { kind: 'wait', ...busy, limit: 1 },
  ],
  [
    'outside load starts it anyway once the bound passed',
    [busy, 1, 0, PRESSURE_WAIT_MS],
    { kind: 'forced', ...busy, waited: PRESSURE_WAIT_MS },
  ],
])('gate: %s', (_name, args, gate) => {
  expect(cpuGate(...args)).toEqual(gate)
})

const at = (seconds: number, cpuSeconds: number): CpuSample => ({
  at: seconds * 1000,
  cpuMs: cpuSeconds * 1000,
})
const probe = PROBATION_MS / 1000

it.each<[string, Observation, CpuSample, Observation]>([
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
    'climbing for a probation turns heavy',
    { kind: 'climbing', since: 100_000, last: at(115, 40) },
    at(100 + probe, 52),
    { kind: 'heavy', last: at(100 + probe, 52) },
  ],
  [
    'climbing that calms is light again',
    { kind: 'climbing', since: 100_000, last: at(105, 20) },
    at(110, 21),
    { kind: 'light', last: at(110, 21) },
  ],
  [
    'a heavy job below half a core starts cooling',
    { kind: 'heavy', last: at(100, 100) },
    at(110, 101),
    { kind: 'cooling', since: 100_000, last: at(110, 101) },
  ],
  [
    'cooling for a minute lets the slot go',
    { kind: 'cooling', since: 100_000, last: at(150, 102) },
    at(100 + LIGHT_FOR_MS / 1000, 103),
    { kind: 'light', last: at(100 + LIGHT_FOR_MS / 1000, 103) },
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
])('observe: %s', (_name, before, sample, after) => {
  expect(observe(before, sample)).toEqual(after)
})

it('measures a bash command over its own, longer window', () => {
  let observation: Observation = { kind: 'light', last: at(0, 0) }
  for (let seconds = 5; seconds < BASH_WINDOW_MS / 1000; seconds += 5) {
    observation = observe(observation, at(seconds, seconds * 2), BASH_WINDOW_MS)
    expect(observation.kind).toBe('climbing')
  }
  expect(observe(observation, at(BASH_WINDOW_MS / 1000, 60), BASH_WINDOW_MS).kind).toBe('heavy')
})
