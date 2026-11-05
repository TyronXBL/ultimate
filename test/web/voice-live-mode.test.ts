import { expect, it } from 'vitest'
import { stepVoiceMode } from '../../extensions/voice-live/mode.ts'
import type { VoiceMode, VoiceModeEvent } from '../../extensions/voice-live/mode.ts'

const base = { muted: false, front: false }
const off: VoiceMode = { ...base, phase: 'off' }
const starting: VoiceMode = { ...base, front: true, phase: 'starting', from: 'off' }
const ending: VoiceMode = { ...starting, phase: 'ending' }
const paused: VoiceMode = { ...base, front: true, phase: 'paused' }
const live: VoiceMode = { ...base, front: true, phase: 'live', since: 1000 }
const reading = { entry: 7, words: 0, at: 4000 }
const sending = { kind: 'sending', text: 'hello', at: 3000 } as const

type Row = [
  name: string,
  from: VoiceMode,
  event: VoiceModeEvent,
  expected: { mode: VoiceMode; cue?: string; hum?: string },
]

const rows: Row[] = [
  [
    'start from off brings Voice to the front and hums',
    off,
    { type: 'start' },
    { mode: starting, hum: 'start' },
  ],
  [
    'start from paused keeps the front and drops the old problem and waiting answer',
    { ...paused, front: false, problem: 'old', waiting: 'answer' },
    { type: 'start' },
    { mode: { ...starting, from: 'paused', front: false }, hum: 'start' },
  ],
  [
    'started goes live, sounds ready, stops the hum and keeps a problem from the connection',
    { ...starting, problem: 'flaky' },
    { type: 'started', now: 5 },
    { mode: { ...live, since: 5, problem: 'flaky' }, cue: 'ready', hum: 'stop' },
  ],
  [
    'a failed first start leaves voice mode with the failed cue',
    starting,
    { type: 'startFailed', problem: 'No microphone found' },
    { mode: { ...off, problem: 'No microphone found' }, cue: 'failed', hum: 'stop' },
  ],
  [
    'a failed wake keeps the mode paused with the answer waiting for a tap',
    { ...starting, from: 'paused' },
    { type: 'startFailed', problem: 'blocked', waiting: 'Done.' },
    { mode: { ...paused, problem: 'blocked', waiting: 'Done.' }, cue: 'failed', hum: 'stop' },
  ],
  [
    'End while connecting waits for the start to come back',
    starting,
    { type: 'end' },
    { mode: ending, hum: 'stop' },
  ],
  [
    'the start failing after End leaves voice mode with nothing left over and no failed cue',
    { ...ending, muted: true },
    { type: 'startFailed', problem: 'cancelled' },
    { mode: off, cue: 'ended' },
  ],
  [
    'a start that connected after End is released off with nothing left over',
    { ...ending, muted: true },
    { type: 'release', phase: 'off' },
    { mode: off, cue: 'ended' },
  ],
  [
    'an idle session pauses: paused cue, live fields cleared, problem and front kept',
    { ...live, problem: 'p', floor: 'voice', line: sending, speaking: reading },
    { type: 'release', phase: 'paused' },
    { mode: { ...paused, problem: 'p' }, cue: 'paused' },
  ],
  [
    'a session closed under us pauses with the reason given',
    live,
    { type: 'release', phase: 'paused', problem: 'The session closed' },
    { mode: { ...paused, problem: 'The session closed' }, cue: 'paused' },
  ],
  [
    'the floor and words heard follow the relay, replacing a line still sending',
    { ...live, line: sending },
    { type: 'floor', floor: 'user', partial: 'and', now: 4000 },
    { mode: { ...live, floor: 'user', line: { kind: 'hearing', partial: 'and' } } },
  ],
  [
    'a line that ends is sending until its heard entry arrives',
    { ...live, floor: 'user', line: { kind: 'hearing', partial: 'hello' } },
    { type: 'floor', partial: undefined, now: 3000 },
    { mode: { ...live, line: sending } },
  ],
  [
    'sending is kept until 6000 ms have passed',
    { ...live, line: sending },
    { type: 'floor', now: 9000 },
    { mode: { ...live, line: sending } },
  ],
  [
    'sending expires after 6000 ms',
    { ...live, line: sending },
    { type: 'floor', now: 9001 },
    { mode: live },
  ],
  [
    'a Voice line starts being read out at word 0',
    live,
    { type: 'speaking', entry: 7, at: 4000 },
    { mode: { ...live, speaking: reading } },
  ],
  [
    'reading follows the words said while GPT-Live talks',
    { ...live, speaking: reading },
    { type: 'speakingProgress', words: 3, talking: true, now: 4500 },
    { mode: { ...live, speaking: { ...reading, words: 3 } } },
  ],
  [
    'reading finishes once GPT-Live falls quiet after some words',
    { ...live, speaking: { ...reading, words: 3 } },
    { type: 'speakingProgress', words: 3, talking: false, now: 5000 },
    { mode: live },
  ],
  [
    'reading waits through 8000 ms of silence before any word',
    { ...live, speaking: reading },
    { type: 'speakingProgress', words: 0, talking: false, now: 12000 },
    { mode: { ...live, speaking: reading } },
  ],
  [
    'reading finishes after 8000 ms of silence',
    { ...live, speaking: reading },
    { type: 'speakingProgress', words: 0, talking: false, now: 12001 },
    { mode: live },
  ],
  [
    'an answer that cannot wake the browser waits for a tap',
    paused,
    { type: 'waiting', text: 'Done.' },
    { mode: { ...paused, waiting: 'Done.' } },
  ],
]

it.each(rows)('%s', (_name, from, event, expected) => {
  expect(stepVoiceMode(from, event)).toEqual(expected)
})

it('returns the same mode, with no cue or hum, for an event that changes nothing', () => {
  const waiting = { ...paused, waiting: 'Done.' }
  for (const [mode, event] of [
    [waiting, { type: 'waiting', text: 'Done.' }],
    [live, { type: 'speaking', at: 1 }],
    [
      { ...live, floor: 'user' },
      { type: 'floor', floor: 'user', now: 1 },
    ],
    [off, { type: 'startFailed', problem: 'late' }],
  ] satisfies [VoiceMode, VoiceModeEvent][]) {
    const step = stepVoiceMode(mode, event)
    expect(step.mode).toBe(mode)
    expect(step).toEqual({ mode })
  }
})
