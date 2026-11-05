import { expect, it } from 'vitest'
import { stepVoiceMode } from '../../extensions/voice-live/mode.ts'
import type { VoiceMode, VoiceModeEvent } from '../../extensions/voice-live/mode.ts'

const base = { muted: false, front: false }
const off: VoiceMode = { ...base, phase: 'off' }
const starting: VoiceMode = { ...base, front: true, phase: 'starting' }
const ending: VoiceMode = { ...starting, phase: 'ending' }
const paused: VoiceMode = { ...base, front: true, phase: 'paused' }
const live: VoiceMode = { ...base, front: true, phase: 'live', since: 1000 }

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
    'start from paused keeps the front, drops the old problem and waiting answer',
    { ...paused, front: false, problem: 'old', waiting: 'answer' },
    { type: 'start' },
    { mode: { ...starting, front: false }, hum: 'start' },
  ],
  ['start while live is ignored', live, { type: 'start' }, { mode: live }],
  [
    'started goes live, sounds ready, stops the hum and keeps a problem from the connection',
    { ...starting, problem: 'flaky' },
    { type: 'started', now: 5 },
    { mode: { ...live, since: 5, problem: 'flaky' }, cue: 'ready', hum: 'stop' },
  ],
  [
    'a failed first start leaves voice mode with the failed cue',
    starting,
    { type: 'startFailed', from: 'off', problem: 'No microphone found', cancelled: false },
    { mode: { ...off, problem: 'No microphone found' }, cue: 'failed', hum: 'stop' },
  ],
  [
    'a failed wake keeps the mode paused with the answer waiting for a tap',
    { ...starting, front: true },
    { type: 'startFailed', from: 'paused', problem: 'blocked', waiting: 'Done.', cancelled: false },
    { mode: { ...paused, problem: 'blocked', waiting: 'Done.' }, cue: 'failed', hum: 'stop' },
  ],
  [
    'End while connecting, then the start failing: off, nothing left over, no failed cue',
    { ...ending, muted: true },
    { type: 'startFailed', from: 'off', problem: 'cancelled', cancelled: true },
    { mode: off, cue: 'ended' },
  ],
  [
    'End while connecting waits for the start',
    starting,
    { type: 'end' },
    { mode: ending, hum: 'stop' },
  ],
  [
    'End from live leaves voice mode and forgets muted, front and the live fields',
    {
      ...live,
      muted: true,
      floor: 'user',
      partial: 'hel',
      speaking: { entry: 1, words: 1, at: 1 },
    },
    { type: 'end' },
    { mode: off, cue: 'ended' },
  ],
  [
    'a cancelled start that connected anyway is released off, with nothing left over',
    { ...ending, muted: true },
    { type: 'release', phase: 'off' },
    { mode: off, cue: 'ended' },
  ],
  [
    'an idle session pauses: paused cue, live-only fields cleared, problem and front kept',
    {
      ...live,
      problem: 'p',
      floor: 'voice',
      partial: 'x',
      sending: { text: 't', at: 1 },
      speaking: { entry: 1, words: 1, at: 1 },
    },
    { type: 'release', phase: 'paused' },
    { mode: { ...paused, problem: 'p' }, cue: 'paused' },
  ],
  [
    'a session closed under us pauses with a reason',
    { ...live, floor: 'user' },
    { type: 'closedUnderUs' },
    { mode: { ...paused, problem: 'The session closed' }, cue: 'paused' },
  ],
  [
    'a session closed under us keeps the reason already shown',
    { ...live, problem: 'Session closed: expired' },
    { type: 'closedUnderUs' },
    { mode: { ...paused, problem: 'Session closed: expired' }, cue: 'paused' },
  ],
  [
    'the floor and the words heard follow the relay',
    live,
    { type: 'floor', floor: 'user', partial: 'hello', now: 2000 },
    { mode: { ...live, floor: 'user', partial: 'hello' } },
  ],
  [
    'a line that ends is sending until its heard entry arrives',
    { ...live, floor: 'user', partial: 'hello' },
    { type: 'floor', floor: undefined, partial: undefined, now: 3000 },
    { mode: { ...live, sending: { text: 'hello', at: 3000 } } },
  ],
  [
    'sending is kept until 6000 ms have passed',
    { ...live, sending: { text: 'hello', at: 3000 } },
    { type: 'floor', floor: undefined, partial: undefined, now: 9000 },
    { mode: { ...live, sending: { text: 'hello', at: 3000 } } },
  ],
  [
    'sending expires after 6000 ms',
    { ...live, sending: { text: 'hello', at: 3000 } },
    { type: 'floor', floor: undefined, partial: undefined, now: 9001 },
    { mode: live },
  ],
  [
    'a new line replaces the one sending',
    { ...live, sending: { text: 'hello', at: 3000 } },
    { type: 'floor', floor: 'user', partial: 'and', now: 4000 },
    { mode: { ...live, floor: 'user', partial: 'and' } },
  ],
  [
    'a Voice line starts being read out at word 0',
    live,
    { type: 'speaking', entry: 7, at: 4000 },
    { mode: { ...live, speaking: { entry: 7, words: 0, at: 4000 } } },
  ],
  [
    'a line with no entry on screen clears what was being read',
    { ...live, speaking: { entry: 7, words: 2, at: 4000 } },
    { type: 'speaking', at: 4500 },
    { mode: live },
  ],
  [
    'reading follows the words said while GPT-Live talks',
    { ...live, speaking: { entry: 7, words: 0, at: 4000 } },
    { type: 'speakingProgress', words: 3, talking: true, now: 4500 },
    { mode: { ...live, speaking: { entry: 7, words: 3, at: 4000 } } },
  ],
  [
    'reading finishes once GPT-Live falls quiet after some words',
    { ...live, speaking: { entry: 7, words: 3, at: 4000 } },
    { type: 'speakingProgress', words: 3, talking: false, now: 5000 },
    { mode: live },
  ],
  [
    'reading waits through 8000 ms of silence before any word',
    { ...live, speaking: { entry: 7, words: 0, at: 4000 } },
    { type: 'speakingProgress', words: 0, talking: false, now: 12000 },
    { mode: { ...live, speaking: { entry: 7, words: 0, at: 4000 } } },
  ],
  [
    'reading finishes after 8000 ms of silence',
    { ...live, speaking: { entry: 7, words: 0, at: 4000 } },
    { type: 'speakingProgress', words: 0, talking: false, now: 12001 },
    { mode: live },
  ],
  [
    'an answer that cannot wake the browser waits for a tap',
    paused,
    { type: 'waiting', text: 'Done.' },
    { mode: { ...paused, waiting: 'Done.' } },
  ],
  [
    'an answer waiting is only held while paused',
    live,
    { type: 'waiting', text: 'Done.' },
    { mode: live },
  ],
  [
    'muting is kept in any phase',
    paused,
    { type: 'muted', muted: true },
    { mode: { ...paused, muted: true } },
  ],
  [
    'the front view toggles',
    live,
    { type: 'front', front: false },
    { mode: { ...live, front: false } },
  ],
  [
    'a problem is shown and dismissed',
    { ...off, problem: 'No microphone found' },
    { type: 'problem' },
    { mode: off },
  ],
]

it.each(rows)('%s', (_name, from, event, expected) => {
  expect(stepVoiceMode(from, event)).toEqual(expected)
})
