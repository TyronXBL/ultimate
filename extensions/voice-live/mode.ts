/**
 * This tab's voice mode as a state machine. `VoiceMode` is a union on `phase`, each phase carrying exactly its fields,
 * and `stepVoiceMode` is the only thing that builds one: pure, time passed in, answering with the audio side effects
 * (a cue, the connecting hum) the caller performs. Browser-safe: the live indicator and cards read it.
 */

/** Shared by every phase. */
type Base = {
  /** Kept across sessions, so a session that wakes for an answer never opens a muted microphone. */
  muted: boolean
  /** The Voice conversation sits in front of @ultimate's. Not durable: voice mode ends with its page. */
  front: boolean
  /** Why the session stopped, or what failed: shown in the indicator, never only in the console. */
  problem?: string
}

export type VoiceMode =
  | (Base & { phase: 'off' })
  | (Base & { phase: 'starting' })
  | (Base & { phase: 'ending' })
  // In voice mode without a session, listening paused until an answer or a tap wakes it.
  | (Base & {
      phase: 'paused'
      /** An answer that arrived while paused, when this browser would not restart without a tap. */
      waiting?: string
    })
  | (Base & {
      phase: 'live'
      /** When the session went live: its billed time. */
      since: number
      /** Who has the floor: the user mid-sentence, or GPT-Live talking. */
      floor?: 'user' | 'voice'
      /** The words of the line the user is saying now, before a pause finishes it. */
      partial?: string
      /** A line just finished and on its way to Voice: shown until its `voice.heard` entry arrives. */
      sending?: { text: string; at: number }
      /** The Voice line GPT-Live is reading out now, and how many of its words it has said so far. */
      speaking?: { entry: number; words: number; at: number }
    })

export type VoiceModeEvent =
  | { type: 'start' }
  | { type: 'started'; now: number }
  // `from` is the phase `start` left: a failed wake leaves a paused mode paused, a failed first start leaves voice mode.
  | {
      type: 'startFailed'
      from: 'off' | 'paused'
      problem: string
      waiting?: string
      cancelled: boolean
    }
  | { type: 'release'; phase: 'off' | 'paused' }
  | { type: 'closedUnderUs' }
  | { type: 'floor'; floor?: 'user' | 'voice'; partial?: string; now: number }
  | { type: 'speaking'; entry?: number; at: number }
  | { type: 'speakingProgress'; words: number; talking: boolean; now: number }
  | { type: 'waiting'; text: string }
  | { type: 'muted'; muted: boolean }
  | { type: 'front'; front: boolean }
  | { type: 'problem'; problem?: string }
  | { type: 'end' }

export type VoiceCue = 'ready' | 'paused' | 'ended' | 'failed'

/** A just-finished line stays on screen this long for its heard entry to arrive. */
const SENDING_MS = 6000
/** GPT-Live may never read a line out (interrupted, or paraphrased into silence): then show it whole after this. */
const SILENT_MS = 8000

/** The cue a phase change sounds: going live, an idle or dropped session pausing, voice mode ending. */
function cueOf(from: VoiceMode['phase'], to: VoiceMode['phase']): VoiceCue | undefined {
  if (from === to) return undefined
  if (to === 'live') return 'ready'
  if (to === 'paused' && from === 'live') return 'paused'
  if (to === 'off' && from !== 'starting') return 'ended'
  return undefined
}

/** Voice mode left: nothing of it stays, not the microphone setting, the front view or a problem. */
const off = (problem?: string): VoiceMode => ({ phase: 'off', muted: false, front: false, problem })
const paused = (mode: VoiceMode, problem = mode.problem, waiting?: string): VoiceMode => ({
  phase: 'paused',
  muted: mode.muted,
  front: mode.front,
  problem,
  waiting,
})

function transition(mode: VoiceMode, event: VoiceModeEvent): VoiceMode {
  switch (event.type) {
    case 'start':
      if (mode.phase !== 'off' && mode.phase !== 'paused') return mode
      return {
        phase: 'starting',
        muted: mode.muted,
        front: mode.phase === 'off' ? true : mode.front,
      }
    case 'started':
      if (mode.phase !== 'starting') return mode
      return {
        phase: 'live',
        muted: mode.muted,
        front: mode.front,
        problem: mode.problem,
        since: event.now,
      }
    case 'startFailed':
      if (event.cancelled) return off()
      return event.from === 'off' ? off(event.problem) : paused(mode, event.problem, event.waiting)
    case 'release':
      if (mode.phase === 'off') return mode
      return event.phase === 'off' ? off() : paused(mode)
    case 'end':
      if (mode.phase === 'off') return mode
      return mode.phase === 'starting' ? { ...mode, phase: 'ending' } : off()
    case 'closedUnderUs':
      // startLive already released the session and recorded the end; the mode sleeps, as after idling.
      return mode.phase === 'live' ? paused(mode, mode.problem ?? 'The session closed') : mode
    case 'floor': {
      if (mode.phase !== 'live') return mode
      if (event.floor !== mode.floor || event.partial !== mode.partial)
        return {
          ...mode,
          floor: event.floor,
          partial: event.partial,
          sending: event.partial
            ? undefined
            : mode.partial
              ? { text: mode.partial, at: event.now }
              : mode.sending,
        }
      return mode.sending && event.now - mode.sending.at > SENDING_MS
        ? { ...mode, sending: undefined }
        : mode
    }
    case 'speaking':
      if (mode.phase !== 'live') return mode
      return {
        ...mode,
        speaking:
          event.entry === undefined ? undefined : { entry: event.entry, words: 0, at: event.at },
      }
    case 'speakingProgress': {
      if (mode.phase !== 'live' || !mode.speaking) return mode
      // Once GPT-Live falls quiet after the line, or never starts it, show it whole.
      const silent = event.words === 0 && event.now - mode.speaking.at > SILENT_MS
      if ((event.words > 0 && !event.talking) || silent) return { ...mode, speaking: undefined }
      return event.words === mode.speaking.words
        ? mode
        : { ...mode, speaking: { ...mode.speaking, words: event.words } }
    }
    case 'waiting':
      return mode.phase === 'paused' ? { ...mode, waiting: event.text } : mode
    case 'muted':
      return event.muted === mode.muted ? mode : { ...mode, muted: event.muted }
    case 'front':
      return event.front === mode.front ? mode : { ...mode, front: event.front }
    case 'problem':
      return event.problem === mode.problem ? mode : { ...mode, problem: event.problem }
    default:
      return event satisfies never
  }
}

/**
 * The next mode, and what the caller does about it: play a `cue`, start or stop the connecting `hum` (it lasts exactly
 * as long as `starting`). The same `mode` object comes back when the event changes nothing.
 */
export function stepVoiceMode(
  mode: VoiceMode,
  event: VoiceModeEvent,
): { mode: VoiceMode; cue?: VoiceCue; hum?: 'start' | 'stop' } {
  const next = transition(mode, event)
  if (next === mode) return { mode }
  const was = mode.phase === 'starting'
  const is = next.phase === 'starting'
  return {
    mode: next,
    cue:
      event.type === 'startFailed' && !event.cancelled ? 'failed' : cueOf(mode.phase, next.phase),
    hum: is && !was ? 'start' : was && !is ? 'stop' : undefined,
  }
}

/** The answer waiting for a tap, which only a paused mode holds. */
export const waitingOf = (mode: VoiceMode) => (mode.phase === 'paused' ? mode.waiting : undefined)

/** What the mode is, in two or three words. */
export function stateLabel(mode: VoiceMode) {
  if (mode.phase === 'starting') return 'Connecting…'
  if (mode.phase === 'ending') return 'Ending…'
  if (mode.phase === 'paused') return mode.waiting ? 'Answer waiting' : 'Listening paused'
  return mode.muted ? 'Muted' : 'Live'
}
