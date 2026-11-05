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

/** What `start` left, so a failed or cancelled start knows where to go back to. */
type Origin = 'off' | 'paused'

/** The user's line: the words heard now, or a finished line on its way to Voice until its `voice.heard` entry arrives. */
type Line = { kind: 'hearing'; partial: string } | { kind: 'sending'; text: string; at: number }

export type VoiceMode =
  | (Base & { phase: 'off' })
  | (Base & { phase: 'starting'; from: Origin })
  // End pressed while connecting: waits for the start to come back.
  | (Base & { phase: 'ending'; from: Origin })
  // In voice mode without a session; `waiting` is an answer that needs a tap, as the browser would not restart.
  | (Base & { phase: 'paused'; waiting?: string })
  | (Base & {
      phase: 'live'
      /** When the session went live: its billed time. */
      since: number
      /** Who has the floor: the user mid-sentence, or GPT-Live talking. */
      floor?: 'user' | 'voice'
      line?: Line
      /** The Voice line GPT-Live is reading out now, and how many of its words it has said so far. */
      speaking?: { entry: number; words: number; at: number }
    })

export type VoiceModeEvent =
  | { type: 'start' }
  | { type: 'started'; now: number }
  | { type: 'startFailed'; problem: string; waiting?: string }
  | { type: 'release'; phase: 'off' | 'paused'; problem?: string }
  | { type: 'floor'; floor?: 'user' | 'voice'; partial?: string; now: number }
  | { type: 'speaking'; entry?: number; at: number }
  | { type: 'speakingProgress'; words: number; talking: boolean; now: number }
  | { type: 'waiting'; text: string }
  | { type: 'muted'; muted: boolean }
  | { type: 'front'; front: boolean }
  | { type: 'problem'; problem?: string }
  | { type: 'end' }

export type VoiceCue = 'ready' | 'paused' | 'ended' | 'failed'

/** A finished line stays on screen this long for its heard entry to arrive. */
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
        from: mode.phase,
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
      if (mode.phase === 'ending') return off()
      if (mode.phase !== 'starting') return mode
      return mode.from === 'off' ? off(event.problem) : paused(mode, event.problem, event.waiting)
    case 'release':
      // A session that closed under us (expiry, a dropped peer) pauses with a reason unless one is already shown.
      if (mode.phase === 'off') return mode
      return event.phase === 'off' ? off() : paused(mode, mode.problem ?? event.problem)
    case 'end':
      return mode.phase === 'starting' ? { ...mode, phase: 'ending' } : mode
    case 'floor': {
      if (mode.phase !== 'live') return mode
      const partial = mode.line?.kind === 'hearing' ? mode.line.partial : undefined
      if (event.floor !== mode.floor || event.partial !== partial)
        return {
          ...mode,
          floor: event.floor,
          line: event.partial
            ? { kind: 'hearing', partial: event.partial }
            : partial
              ? { kind: 'sending', text: partial, at: event.now }
              : mode.line,
        }
      return mode.line?.kind === 'sending' && event.now - mode.line.at > SENDING_MS
        ? { ...mode, line: undefined }
        : mode
    }
    case 'speaking':
      if (mode.phase !== 'live') return mode
      if (event.entry === undefined) return mode.speaking ? { ...mode, speaking: undefined } : mode
      return { ...mode, speaking: { entry: event.entry, words: 0, at: event.at } }
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
      return mode.phase === 'paused' && event.text !== mode.waiting
        ? { ...mode, waiting: event.text }
        : mode
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
      event.type === 'startFailed' && mode.phase === 'starting'
        ? 'failed'
        : cueOf(mode.phase, next.phase),
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
