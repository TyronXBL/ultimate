/**
 * The journey from a dream into a fresh chapter, written only by `dreamStep` and read only through the derivations
 * below. Pure and browser-safe: callers pass the time and store what these return.
 */
import type { Backup, Dream, Journey, Prepared, Sleep } from './refs.ts'

export type DreamEvent =
  | { type: 'dreamed'; dream: Dream }
  | { type: 'asked'; at: number }
  | { type: 'dismissed' }
  | { type: 'prepared'; prepared: Prepared }
  /** `chapter`: the name the user chose; the prepared one otherwise. */
  | { type: 'sleep started'; chapter?: string; at: number }
  | { type: 'backing up'; at: number }
  | { type: 'backed up'; backup: Backup; at: number }
  | { type: 'switching'; at: number }
  | { type: 'asleep'; at: number }
  | { type: 'failed'; error: string; at: number }

type Of<S extends Journey['state']> = Extract<Journey, { state: S }>
const dreamOf = (journey: Journey) => ('dream' in journey ? journey.dream : undefined)
/** The dream a prepared chapter followed, for the state that keeps it. */
const kept = (journey: Journey) => {
  const dream = dreamOf(journey)
  return dream ? { dream } : {}
}

/**
 * The journey after `event`. An event the state cannot take throws, naming why. A dream recorded while a sleep runs
 * changes nothing: the user chose to sleep, and can dream again if it fails (a dream would take the Fall asleep card
 * from the sleep, and work it starts cancels the switch anyway). A dream whose request is not newer than the last
 * recorded one's is a replayed or second branch of that request.
 */
export function dreamStep(
  journey: Journey,
  event: Extract<DreamEvent, { type: 'asked' }>,
): Of<'preparing'>
export function dreamStep(
  journey: Journey,
  event: Extract<DreamEvent, { type: 'sleep started' }>,
): Of<'sleeping'>
export function dreamStep(
  journey: Journey,
  event: Extract<DreamEvent, { type: 'failed' }>,
): Of<'failed'>
export function dreamStep(journey: Journey, event: DreamEvent): Journey
export function dreamStep(journey: Journey, event: DreamEvent): Journey {
  if (event.type === 'dreamed') {
    if (journey.state === 'sleeping') return journey
    const last = dreamOf(journey)
    if (last && event.dream.requested <= last.requested) return journey
    return { state: 'woke', dream: event.dream }
  }
  if (event.type === 'asked') {
    if (journey.state === 'idle') throw new Error('No dream to wake from: start one with Dream')
    if ('prepared' in journey)
      throw new Error(`Chapter ${journey.prepared.chapter} is already prepared`)
    return { state: 'preparing', dream: journey.dream, asked: event.at }
  }
  if (event.type === 'dismissed')
    return journey.state === 'woke' || journey.state === 'preparing'
      ? { state: 'dismissed', dream: journey.dream }
      : journey
  if (event.type === 'prepared') {
    if (journey.state === 'sleeping')
      throw new Error(`Falling asleep is under way (${journey.phase})`)
    return { state: 'prepared', prepared: event.prepared, ...kept(journey) }
  }
  if (event.type === 'sleep started') {
    if (journey.state === 'sleeping')
      throw new Error(`Falling asleep is under way (${journey.phase})`)
    if (journey.state !== 'prepared' && journey.state !== 'failed')
      throw new Error('Nothing is prepared: @ultimate prepares the next chapter first')
    return {
      state: 'sleeping',
      prepared: journey.prepared,
      chapter: event.chapter ?? journey.prepared.chapter,
      phase: 'seeding',
      at: event.at,
      ...kept(journey),
    }
  }
  // Sleep progress: in order seeding, backing up (with its backup recorded), switching, then asleep or failed; the
  // chapter never changes.
  if (journey.state !== 'sleeping') throw new Error(`No sleep is running to ${event.type}`)
  const { prepared, chapter, backup } = journey
  if (event.type === 'failed')
    return {
      state: 'failed',
      prepared,
      chapter,
      ...(backup && { backup }),
      error: event.error,
      at: event.at,
      ...kept(journey),
    }
  const from = {
    'backing up': 'seeding',
    'backed up': 'backing up',
    switching: 'backing up',
    asleep: 'switching',
  }[event.type]
  if (journey.phase !== from)
    throw new Error(`Falling asleep cannot ${event.type} from ${journey.phase}`)
  if (event.type === 'switching' && !backup)
    throw new Error('Falling asleep cannot switching before the backup is recorded')
  if (event.type === 'asleep')
    return { state: 'asleep', prepared, chapter, at: event.at, ...kept(journey) }
  if (event.type === 'backed up') return { ...journey, backup: event.backup, at: event.at }
  return { ...journey, phase: event.type, at: event.at }
}

/** The prepared chapter, in any state that carries one. */
export const preparedOf = (journey: Journey): Prepared | undefined =>
  'prepared' in journey ? journey.prepared : undefined

/** The sleep into the prepared chapter: running, failed or done. */
export function sleepOf(journey: Of<'sleeping' | 'failed' | 'asleep'>): Sleep
export function sleepOf(journey: Journey): Sleep | undefined
export function sleepOf(journey: Journey): Sleep | undefined {
  if (journey.state === 'sleeping') {
    const { phase, chapter, backup, at } = journey
    return { phase, chapter, ...(backup && { backup }), at }
  }
  if (journey.state === 'failed') {
    const { chapter, backup, error, at } = journey
    return { phase: 'failed', chapter, ...(backup && { backup }), error, at }
  }
  if (journey.state === 'asleep')
    return { phase: 'asleep', chapter: journey.chapter, at: journey.at }
  return undefined
}

/**
 * The chapter prepared since the last dream, with its sleep, while it waits to be slept into (or that sleep runs or
 * failed); undefined once slept into, and when a newer dream superseded it.
 */
export function waiting(journey?: Journey | null) {
  if (journey?.state !== 'prepared' && journey?.state !== 'sleeping' && journey?.state !== 'failed')
    return undefined
  return { prepared: journey.prepared, sleep: sleepOf(journey) }
}

/**
 * Where the way into a fresh chapter stands for the user: `woke` once the dream's branch is `concluded`, `preparing`
 * after they pressed Fall asleep, `prepared` while a prepared chapter waits; undefined when there is nothing to do.
 */
export function awakeOf(journey: Journey | undefined, concluded: (branch: number) => boolean) {
  if (!journey) return undefined
  const chapter = waiting(journey)?.prepared.chapter
  if (chapter) return { phase: 'prepared' as const, chapter }
  if (journey.state !== 'woke' && journey.state !== 'preparing') return undefined
  if (!concluded(journey.dream.branch)) return undefined
  return { phase: journey.state, branch: journey.dream.branch }
}
