// The supervisor's lifecycle (`bin/ultimate.ts`) and the core's serving phase (`server/main.ts`), as pure machines.
// `stepSupervisor` and `stepCorePhase` are their only writers; `routeMode` and `shouldExitOnStorageFailure` the
// derivations every reader uses. `T` is the supervisor's core handle, compared by identity.

/**
 * - `down`: no core serves and nothing is booting (the start, or a core just lost).
 * - `recovering`: booting a core; after 3 failed boots it parks on the crash page.
 * - `active`: `core` serves.
 * - `swapping`: a core swap runs; `core` serves until the old one is released, none while it is, then the new or restored one.
 * - `crashed`: parked on the crash page until a watcher retries.
 * - `stopping`: shutting down; nothing starts again.
 */
export type SupervisorState<T> =
  | { kind: 'down' }
  | { kind: 'recovering'; failures: number } // boots failed so far
  | { kind: 'active'; core: T }
  | { kind: 'swapping'; core?: T }
  | { kind: 'crashed' }
  | { kind: 'stopping' }

export type SupervisorEvent<T> =
  /** Recovery begins (only from `down`). */
  | { type: 'recover' }
  /** A boot attempt failed. */
  | { type: 'boot failed' }
  /** The attempts ran out. */
  | { type: 'parked' }
  /** A watcher saw a change: a parked supervisor tries again from the start. */
  | { type: 'retry' }
  /** `core` is ready and serves. */
  | { type: 'started'; core: T }
  | { type: 'swap' }
  /** The swap holds no serving core: the old one was released, or the restored one failed. */
  | { type: 'released' }
  | { type: 'swap ended' }
  | { type: 'exited'; core: T }
  | { type: 'stop' }

export const initialSupervisorState = <T>(): SupervisorState<T> => ({ kind: 'down' })

/** The core serving sockets, if any. */
export const servingCore = <T>(state: SupervisorState<T>) =>
  state.kind === 'active' || state.kind === 'swapping' ? state.core : undefined

/** Where an incoming socket goes: the serving core, the crash page, or held until a core serves. */
export function routeMode<T>(
  state: SupervisorState<T>,
): { kind: 'active'; core: T } | { kind: 'crash' } | { kind: 'queue' } {
  const core = servingCore(state)
  if (core) return { kind: 'active', core }
  return state.kind === 'crashed' ? { kind: 'crash' } : { kind: 'queue' }
}

/** The state after `event`; an event the state cannot take changes nothing. */
export function stepSupervisor<T>(
  state: SupervisorState<T>,
  event: SupervisorEvent<T>,
): SupervisorState<T> {
  if (state.kind === 'stopping') return state
  switch (event.type) {
    case 'stop':
      return { kind: 'stopping' }
    case 'recover':
      return state.kind === 'down' ? { kind: 'recovering', failures: 0 } : state
    case 'boot failed':
      return state.kind === 'recovering' ? { ...state, failures: state.failures + 1 } : state
    case 'parked':
      return state.kind === 'recovering' ? { kind: 'crashed' } : state
    case 'retry':
      return state.kind === 'crashed' ? { kind: 'down' } : state
    case 'started':
      return state.kind === 'swapping'
        ? { kind: 'swapping', core: event.core }
        : { kind: 'active', core: event.core }
    case 'swap':
      return state.kind === 'swapping'
        ? state
        : { kind: 'swapping', ...(state.kind === 'active' && { core: state.core }) }
    case 'released':
      return state.kind === 'swapping' ? { kind: 'swapping' } : state
    case 'swap ended':
      if (state.kind !== 'swapping') return state
      return state.core ? { kind: 'active', core: state.core } : { kind: 'down' }
    case 'exited':
      break
  }
  if (servingCore(state) !== event.core) return state
  return state.kind === 'swapping' ? { kind: 'swapping' } : { kind: 'down' }
}

/** A core: `prepared` (storage open, not serving), `serving`, or `closing` (for good). */
export type CorePhase = 'prepared' | 'serving' | 'closing'

export function stepCorePhase(phase: CorePhase, event: 'go' | 'release' | 'close'): CorePhase {
  if (event === 'close') return 'closing'
  if (phase === 'closing') return phase
  return event === 'go' ? 'serving' : 'prepared'
}

/** A failed storage only matters while the core serves: then it exits so the supervisor starts a fresh one. */
export const shouldExitOnStorageFailure = (phase: CorePhase) => phase === 'serving'
