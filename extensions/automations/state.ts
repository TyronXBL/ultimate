/** The state of an automation's prompt runs. Browser-safe: `runStep` is the only writer of `automation.runs`. */
import type { ConversationId } from '@earendil-works/pi-durable'

/** A run is going, was skipped because another was, or ended; each state holds only the fields it has. */
export type Run =
  | { status: 'running'; id: string; firedAt: number; conversationId?: ConversationId }
  | { status: 'skipped'; id: string; firedAt: number }
  | {
      status: 'done' | 'failed' | 'aborted'
      id: string
      firedAt: number
      conversationId?: ConversationId
      finishedAt: number
      answer?: string
    }

export type RunEvent =
  | { type: 'start'; id: string; firedAt: number }
  /** A fire that found a run still going. */
  | { type: 'skip'; firedAt: number }
  | { type: 'attach'; id: string; conversationId: ConversationId }
  | {
      type: 'finish'
      id: string
      status: 'done' | 'failed' | 'aborted'
      finishedAt: number
      answer?: string
    }

/** How many runs an automation keeps. */
const KEPT = 50

/** The runs over the cap leave oldest first, but a going run never does: it keeps its abort handle and its answer. */
function trim(runs: Run[]): Run[] {
  let excess = runs.length - KEPT
  return runs.filter((run) => {
    if (excess <= 0 || run.status === 'running') return true
    excess--
    return false
  })
}

/** Whether a run is going: a new fire skips while one is, and only a going run can be aborted. */
export const isRunning = (run: Run | undefined) => run?.status === 'running'
export const hasRunningRun = (runs: Run[]) => runs.some(isRunning)

/** The conversation a run works in; a skipped run has none. */
export const runConversation = (run: Run) =>
  run.status === 'skipped' ? undefined : run.conversationId

/** When a run last changed: its end, or its fire while it is going or was skipped. */
export const runEndedAt = (run: Run) =>
  run.status === 'running' || run.status === 'skipped' ? run.firedAt : run.finishedAt

/** The runs after an event. Attaching to or finishing a run that is not going changes nothing. */
export function runStep(runs: Run[], event: RunEvent): Run[] {
  switch (event.type) {
    case 'start':
      return trim([...runs, { status: 'running', id: event.id, firedAt: event.firedAt }])
    case 'skip':
      return trim([
        ...runs,
        { status: 'skipped', id: `skipped:${event.firedAt}`, firedAt: event.firedAt },
      ])
    case 'attach':
      return runs.map((run) =>
        run.id === event.id && run.status === 'running'
          ? { ...run, conversationId: event.conversationId }
          : run,
      )
    case 'finish':
      return runs.map((run): Run => {
        if (run.id !== event.id || run.status !== 'running') return run
        return {
          ...run,
          status: event.status,
          finishedAt: event.finishedAt,
          // The first line of the answer, cut to what a row shows.
          ...(event.answer !== undefined && {
            answer: event.answer.trim().split('\n')[0].slice(0, 200),
          }),
        }
      })
    default:
      return event satisfies never
  }
}

/** How many unplanned script exits in a row escalate instead of waking the watcher again. */
export const FAILURE_LIMIT = 3
/** An hour of running before an exit means the script worked: its failure count starts again. */
const HEALTHY_MS = 3600_000

/** What a script has in every state. */
type Spec = {
  ask: string
  once: boolean
  secrets?: string[]
  /** A project script's committed `to`: the subscriber its manifest names. */
  to?: string
  conversationId: number
  /** Unplanned exits in a row; the third escalates. A FIRE or an hour of running resets it. */
  failures: number
}
/**
 * The process a script started. Its pid stays until the exit is recorded, even after a pause told it to stop: the exit
 * is matched to the record by it.
 */
type Process = { pid: number; startedAt: number; lastOutputAt?: number }
type Exit = { exitedAt: number; exitCode?: number }

/**
 * A script's lifecycle; each state holds only the fields it has. `scriptStep` is the only writer. Its record is
 * written (or rewritten, or repaired) by the watcher, runs, is repaired after an unplanned exit, and ends failed
 * (escalated), stopped (paused, or DONE) or done (a one-shot that fired).
 */
export type Script = Spec &
  (
    | { state: 'writing'; process?: Process; exit?: Exit }
    | { state: 'running'; process?: Process }
    | { state: 'investigating'; exit: Exit; error: string }
    | { state: 'failed'; error: string; process?: Process; exit?: Exit }
    | { state: 'stopped'; error?: string; process?: Process; exit?: Exit }
    | { state: 'done'; process?: Process; exit?: Exit }
  )

/** The process a script has, or has not yet been reaped of; an investigating script has none. */
export const processOf = (script: Script) => ('process' in script ? script.process : undefined)
/** The pid of the script's process, if it has one. */
export const pidOf = (script: Script | undefined) => script && processOf(script)?.pid
/** How the last process ended; a running script has no exit. */
export const exitOf = (script: Script) => ('exit' in script ? script.exit : undefined)

/** An automation's script and the `enabled` coupled to its state. */
type Scripted = { script: Script; enabled: boolean }

export type ScriptEvent =
  /** The committed manifest of a project script, replacing what it holds. */
  | { type: 'manifest'; ask: string; once: boolean; secrets?: string[]; to: string }
  /** An update's changes to what the script is told. */
  | { type: 'edit'; ask?: string; once?: boolean; secrets?: string[] }
  /** The watcher writes (or rewrites) the script. */
  | { type: 'write' }
  /** Resume or run: the script is to run. */
  | { type: 'resume' }
  /** Pause or delete, or (with a reason) a fire cap that pauses it. */
  | { type: 'pause'; reason?: string }
  | { type: 'escalate'; reason: string }
  /** The process started; without a pid it did not. */
  | { type: 'start'; at: number; pid?: number }
  /** A line of output; a FIRE one resets the failure count. */
  | { type: 'output'; at: number; fire: boolean }
  /** A FIRE was delivered: a one-shot is done. */
  | { type: 'fired' }
  /** The process ended. `stopped` is a planned end (pause, restart, shutdown); `said` that it printed DONE. */
  | {
      type: 'exit'
      at: number
      code: number | null
      stopped: boolean
      said: boolean
      reason: string
    }

/** Writing, running and investigating scripts are enabled; a stopped, failed or done one is not. */
const enabledIn = (state: Script['state']) =>
  state === 'writing' || state === 'running' || state === 'investigating'

/** A new script, with the `enabled` its state implies. */
export function newScript(spec: Omit<Spec, 'failures'>, state: 'writing' | 'stopped'): Scripted {
  return { script: { ...spec, failures: 0, state }, enabled: enabledIn(state) }
}

/**
 * What an exit means to the script: `ignored` (a process nothing expects), `planned` (stopped, or a fired one-shot),
 * `finished` (a recurring script printed DONE and exited 0: it asked to stop) or `failed` (anything else).
 */
export function exitKind(
  script: Script,
  exit: { stopped: boolean; said: boolean; code: number | null },
): 'ignored' | 'planned' | 'finished' | 'failed' {
  if (exit.stopped || (script.once && script.state === 'done')) return 'planned'
  if (script.state !== 'running') return 'ignored'
  return !script.once && exit.said && exit.code === 0 ? 'finished' : 'failed'
}

/** The script and `enabled` after an event. An event the state has no use for changes nothing. */
export function scriptStep(script: Script, event: ScriptEvent): Scripted {
  const {
    state,
    process,
    exit,
    error,
    ...spec
  }: Spec & {
    state: Script['state']
    process?: Process
    exit?: Exit
    error?: string
  } = script
  const next = (value: Script): Scripted => ({ script: value, enabled: enabledIn(value.state) })
  switch (event.type) {
    case 'manifest': {
      const { secrets: _secrets, ...rest } = script
      return next({
        ...rest,
        ask: event.ask,
        once: event.once,
        to: event.to,
        ...(event.secrets && { secrets: event.secrets }),
      })
    }
    case 'edit':
      return next({
        ...script,
        ...(event.ask !== undefined && { ask: event.ask }),
        ...(event.once !== undefined && { once: event.once }),
        ...(event.secrets !== undefined && { secrets: event.secrets }),
      })
    case 'write':
      return next({ ...spec, state: 'writing', ...(process && { process }), ...(exit && { exit }) })
    case 'resume':
      return next({ ...spec, state: 'running', ...(process && { process }) })
    case 'pause': {
      const kept = { ...(process && { process }), ...(exit && { exit }) }
      if (state === 'done') return next({ ...spec, state, ...kept })
      const reason = event.reason ?? error
      return next({
        ...spec,
        state: 'stopped',
        ...(reason !== undefined && { error: reason }),
        ...kept,
      })
    }
    case 'escalate':
      return next({
        ...spec,
        state: 'failed',
        error: event.reason,
        ...(process && { process }),
        ...(exit && { exit }),
      })
    case 'start':
      if (state !== 'running') return next(script)
      return next({
        ...spec,
        state,
        ...(event.pid !== undefined && { process: { pid: event.pid, startedAt: event.at } }),
      })
    case 'output':
      if (state !== 'running' || !process) return next(script)
      return next({
        ...spec,
        state,
        process: { ...process, lastOutputAt: event.at },
        ...(event.fire && { failures: 0 }),
      })
    case 'fired':
      if (state !== 'running' || !spec.once) return next(script)
      return next({ ...spec, state: 'done', ...(process && { process }) })
    case 'exit': {
      const kind = exitKind(script, event)
      if (kind === 'ignored') return next(script)
      const ended = {
        exitedAt: event.at,
        ...(event.code !== null && { exitCode: event.code }),
      }
      if (kind === 'planned') {
        if (script.state === 'running') return next({ ...spec, state: script.state })
        if (script.state === 'investigating') return next({ ...script, exit: ended })
        const { process: _process, ...rest } = script
        return next({ ...rest, exit: ended })
      }
      if (kind === 'finished') return next({ ...spec, state: 'stopped', exit: ended })
      const healthy = !!process && event.at - process.startedAt >= HEALTHY_MS
      const failures = healthy ? 1 : spec.failures + 1
      if (failures >= FAILURE_LIMIT)
        return next({
          ...spec,
          failures,
          state: 'failed',
          error: `Failed ${failures} times in a row: ${event.reason}`,
          exit: ended,
        })
      return next({ ...spec, failures, state: 'investigating', error: event.reason, exit: ended })
    }
    default:
      return event satisfies never
  }
}

/** Advance an automation's script, the only way its script and `enabled` change after creation. */
export function setScript(a: { script?: Script; enabled: boolean }, event: ScriptEvent) {
  Object.assign(a, scriptStep(a.script!, event))
}

/** Pause or resume an automation that has no script, whose `enabled` is its own two-state field. */
export function setEnabled(a: { script?: Script; enabled: boolean }, enabled: boolean) {
  if (a.script) throw new Error('A script automation is enabled by its state')
  a.enabled = enabled
}
