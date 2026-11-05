/**
 * This tab's voice mode: at most one live session, outside React, so a hot reload of `web.tsx` never orphans a running
 * session and its microphone. Voice mode outlasts its sessions: an idle session closes and the mode sleeps until an
 * answer arrives to speak or the user taps resume. Only End leaves it.
 */
import { api, errorMessage, events } from '@/sdk'
import type { ActionRef } from '@/sdk'
import { playNotes } from '../sounds/ui.tsx'
import type { Note } from '../sounds/ui.tsx'
import { StatusAction } from './refs.ts'
import type { VoiceStatus } from './refs.ts'
import { stepVoiceMode } from './mode.ts'
import type { VoiceCue, VoiceMode, VoiceModeEvent } from './mode.ts'
import { IDLE_MS } from './relay.ts'
import type { LiveEvent } from './relay.ts'
import { startLive } from './session.ts'
import type { LiveSession } from './session.ts'

let mode: VoiceMode = { phase: 'off', muted: false, front: false }
let session: LiveSession | undefined
/** Answers to speak once the session starting now is live, with the Voice line each one is. */
let queued: { text: string; entry?: number }[] = []
let closing: Promise<void> | undefined
let ticker: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

/**
 * Cues for the ear, softer and shorter than the notification bells: ready rises a fourth (G5, C6), paused falls back
 * (C6, G5), ended steps down to rest (G5, E5, C5), failed drops low (E4, C♯4). Part of using voice, so the sounds
 * switch does not mute them.
 */
const cues: Record<VoiceCue, Note[]> = {
  ready: [
    [0, 783.99, 0.25],
    [0.1, 1046.5, 0.45],
  ],
  paused: [
    [0, 1046.5, 0.25],
    [0.12, 783.99, 0.5],
  ],
  ended: [
    [0, 783.99, 0.22],
    [0.11, 659.25, 0.22],
    [0.22, 523.25, 0.6],
  ],
  failed: [
    [0, 329.63, 0.25],
    [0.14, 277.18, 0.5],
  ],
}

/**
 * The connecting cue: a quiet hum, G4 under its fifth, breathing at 0.8 Hz until the session is live. Its own audio
 * context, created inside the tap that starts voice so the browser lets it play; closing it silences everything.
 */
let hum: { context: AudioContext; out: GainNode } | undefined

function startHum() {
  if (hum) return
  const context = new AudioContext()
  const now = context.currentTime
  const out = context.createGain()
  // Fades in, so it never clicks.
  out.gain.setValueAtTime(0, now)
  out.gain.linearRampToValueAtTime(0.05, now + 0.4)
  out.connect(context.destination)
  // The pulse: a slow oscillator swings the swell between near silence and full.
  const swell = context.createGain()
  swell.gain.value = 0.5
  const lfo = context.createOscillator()
  const depth = context.createGain()
  lfo.frequency.value = 0.8
  depth.gain.value = 0.45
  lfo.connect(depth).connect(swell.gain)
  swell.connect(out)
  for (const [frequency, level] of [
    [392, 1],
    [587.33, 0.35],
  ]) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequency
    gain.gain.value = level
    oscillator.connect(gain).connect(swell)
    oscillator.start(now)
  }
  lfo.start(now)
  hum = { context, out }
  // Without a gesture behind it (an answer waking a paused session) the browser may keep it shut: silence is fine.
  if (context.state === 'suspended')
    context.resume().catch((error: unknown) => console.warn('Connecting hum blocked', error))
}

/** Fades the hum out in 80 ms and releases its audio context; nothing happens when none plays. */
function stopHum() {
  const current = hum
  hum = undefined
  if (!current) return
  const { context, out } = current
  const now = context.currentTime
  out.gain.cancelScheduledValues(now)
  out.gain.setValueAtTime(out.gain.value, now)
  out.gain.linearRampToValueAtTime(0, now + 0.08)
  setTimeout(() => {
    context.close().catch((error: unknown) => console.warn('Connecting hum close failed', error))
  }, 120)
}

/** The one way the mode changes: `stepVoiceMode` decides, this plays what it asks for and tells the readers. */
function dispatch(event: VoiceModeEvent) {
  const step = stepVoiceMode(mode, event)
  if (step.mode === mode) return
  mode = step.mode
  if (step.hum === 'start') startHum()
  else if (step.hum === 'stop') stopHum()
  // The indicator already shows the phase; a cue the browser refuses is only worth a warning.
  if (step.cue)
    playNotes(cues[step.cue], 0.08).catch((error: unknown) =>
      console.warn('Voice cue failed', error),
    )
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const voiceMode = () => mode
export const setFront = (front: boolean) => dispatch({ type: 'front', front })
export const clearProblem = () => dispatch({ type: 'problem' })

/** The last key status the composer read: a command then starts without a round trip, inside the user's gesture. */
let status: VoiceStatus | undefined
export const rememberStatus = (next: VoiceStatus) => (status = next)

/** Start from a click or a command: a missing key opens its row in Secrets instead of asking for the microphone. */
export async function start() {
  status ??= await api.action(StatusAction)
  if (!status.available) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
  await open()
}
/** The live session's microphone analyser, for a level meter. */
export const analyser = () => session?.analyser

const describe = (error: unknown) => {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') return 'Microphone or audio blocked by the browser'
  if (name === 'NotFoundError') return 'No microphone found'
  return errorMessage(error).replace(/^voice-live\/\w+: /, '')
}

/** Close the session we hold; `phase` is where the mode goes once it has. */
function release(phase: 'off' | 'paused') {
  const current = session
  session = undefined
  clearInterval(ticker)
  dispatch({ type: 'release', phase })
  if (!current) return
  closing = current
    .close()
    .catch((error: unknown) => dispatch({ type: 'problem', problem: describe(error) }))
    .finally(() => (closing = undefined))
}

/** Each tick: follow who has the floor, notice a session that closed under us (expiry, a dropped peer), and close one gone idle. */
function tick() {
  if (!session) return
  if (session.analyser.context.state === 'closed') {
    // startLive already released it and recorded the end; the mode sleeps, as after idling.
    session = undefined
    clearInterval(ticker)
    dispatch({ type: 'release', phase: 'paused', problem: 'The session closed' })
    return
  }
  const now = Date.now()
  const floor = session.relay.hearing() ? 'user' : session.relay.talking() ? 'voice' : undefined
  const partial = session.relay.partial() || undefined
  dispatch({ type: 'floor', floor, partial, now })
  // Follow the line being read out word by word; once GPT-Live falls quiet after it, show it whole.
  if (mode.phase === 'live' && mode.speaking)
    dispatch({
      type: 'speakingProgress',
      words: session.relay.spokenWords(),
      talking: session.relay.talking(),
      now,
    })
  // A forwarded request still unanswered: a short spoken "still on it", first after 20 s, then every 45 s.
  if (asked !== undefined && now - asked >= (nudged ? 45_000 : 20_000)) {
    asked = now
    nudged = true
    try {
      session.speak('Still on it.')
    } catch (error) {
      dispatch({ type: 'problem', problem: describe(error) })
    }
  }
  if (session.relay.idleFor(now) >= IDLE_MS) release('paused')
}
/** Often enough that the words on screen follow speech; the relay itself joins lines every 100 ms. */
const TICK_MS = 150

/** When the open forwarded request went out (or was last nudged about), until its answer is heard. */
let asked: number | undefined
let nudged = false

function onEvent(event: LiveEvent) {
  if (event.type === 'session.closed' && session && mode.phase === 'live')
    dispatch({
      type: 'problem',
      problem: event.reason ? `Session closed: ${event.reason}` : 'The session closed',
    })
}

/** Start a session, from a user gesture or for an answer that arrived while paused. Never two at once. */
export async function open(speech?: string, entry?: number): Promise<void> {
  if (speech) queued.push({ text: speech, entry })
  if (mode.phase === 'starting' || mode.phase === 'live' || mode.phase === 'ending') return
  dispatch({ type: 'start' })
  // Awaiting nothing would still yield, and Safari wants getUserMedia within the tap.
  if (closing) await closing
  let started: LiveSession
  try {
    started = await startLive({
      // api.action's rest arguments do not take a generic A; the ref still names the real args.
      action: <A, R>(ref: ActionRef<A, R>, args: A) =>
        api.action(ref as ActionRef<null, R>, args as null),
      onEvent,
      onError: (error) => dispatch({ type: 'problem', problem: describe(error) }),
    })
  } catch (error) {
    const waiting = queued.at(-1)?.text
    queued = []
    // An answer that could not wake the session waits for a tap; a failed first start leaves voice mode.
    return dispatch({ type: 'startFailed', problem: describe(error), waiting })
  }
  session = started
  // End was pressed while connecting: the session that came back is closed again.
  if (voiceMode().phase === 'ending') return release('off')
  ticker = setInterval(tick, TICK_MS)
  dispatch({ type: 'started', now: Date.now() })
  try {
    if (mode.muted) started.mute()
    for (const item of queued) say(started, item.text, item.entry)
  } catch (error) {
    dispatch({ type: 'problem', problem: describe(error) })
  }
  queued = []
}

/** Driven by open forwarded lines, not an acknowledgement or small-talk say. */
export function working(pending: boolean) {
  if (pending && asked === undefined) {
    asked = Date.now()
    nudged = false
  } else if (!pending) asked = undefined
}

/** Quiet context is only useful to the current live session. */
export function note(text: string) {
  if (!session) return
  try {
    session.send({
      type: 'session.thinking.append',
      event_id: crypto.randomUUID(),
      content: text,
    })
  } catch (error) {
    dispatch({ type: 'problem', problem: describe(error) })
  }
}

/** Read a line out, following it word by word when it is a Voice line on screen. */
function say(live: LiveSession, text: string, entry?: number) {
  live.speak(text)
  dispatch({ type: 'speaking', entry, at: Date.now() })
}

/** An answer to speak: now while live, after the start in flight, or by waking a paused session. */
export function hear(text: string, entry?: number) {
  if (mode.phase === 'live' && session) {
    try {
      say(session, text, entry)
    } catch (error) {
      dispatch({ type: 'problem', problem: describe(error) })
    }
  } else if (mode.phase === 'starting') queued.push({ text, entry })
  else if (mode.phase === 'paused') {
    // Without an earlier gesture on this page the browser keeps the microphone and audio shut: ask for a tap.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive)
      dispatch({ type: 'waiting', text })
    // oxlint-disable-next-line typescript/no-floating-promises -- open never rejects: its failures become `problem`.
    else void open(text, entry)
  }
}

export function setMuted(muted: boolean) {
  try {
    if (session) {
      if (muted) session.mute()
      else session.unmute()
    }
    dispatch({ type: 'muted', muted })
  } catch (error) {
    dispatch({ type: 'problem', problem: describe(error) })
  }
}

/** Leave voice mode: close the session, or cancel the one starting. */
export function end() {
  if (mode.phase === 'off' || mode.phase === 'ending') return
  queued = []
  if (mode.phase === 'starting') return dispatch({ type: 'end' })
  release('off')
}

// A session never outlives its page.
addEventListener('pagehide', () => {
  stopHum()
  if (session) release('off')
})
