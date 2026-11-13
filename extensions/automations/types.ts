import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { TaskId } from '@earendil-works/pi-durable'
import type { Run, Script } from './state.ts'

export type TriggerEvent = { name: string; description: string; fields: Record<string, string> }
/** The labels automations gives the conversations it creates: a prompt run's, and a script's watcher. */
export const RunLabel = 'automation'
export const WatcherLabel = 'watcher'

/**
 * A context condition: armed until it fires, then waiting until the context drops below `above - 10` (see
 * condition.ts, the only writer).
 */
export type Condition = {
  metric: 'context'
  of: string
  above: number
  cooldownMs: number
  armed: boolean
  value?: number
  /** Fire only once the user gave `of` no input for this long (ms): a pause, checked every minute. */
  idleFor?: number
  /** The user's latest input to `of` (ms), kept while `idleFor` is set; the pause counts from creation before one. */
  inputAt?: number
  /** When the condition itself last fired: the cooldown counts from it, not from a manual run. */
  firedAt?: number
}

export type Schedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'at'; time: string }
  | { kind: 'every'; ms: number }
export type { Run }
/** A conversation an automation wakes: `#id` as a number, or a standing agent's `@name`, resolved at each delivery. */
export type Subscriber = number | string
export type Automation = {
  id: string
  scope?: 'project'
  /** The caller's idempotency key: a create with a key that exists returns that automation instead. */
  key?: string
  name: string
  /** A script's follows its state (`scriptStep`); any other trigger's is its own switch (`setEnabled`). */
  enabled: boolean
  createdAt: number
  updatedAt: number
  schedule?: Schedule
  event?: { name: string; where?: Record<string, string | number | boolean>; sinceEvent: number }
  condition?: Condition
  recentFires?: number[]
  /** Only `scriptStep` (state.ts) writes it, and with it `enabled`. */
  script?: Script
  prompt?: string
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  subscribers: Subscriber[]
  nextAt?: number
  scheduler?: TaskId
  runs: Run[]
  fires: number
  lastFireAt?: number
}
export type AutomationListItem = Automation & { alive: boolean }
/**
 * Whether `a` will wake conversation `id` once more and then stop: an enabled `at` schedule or one-shot script that `id`
 * subscribes to, `@name` resolved through `standing`. Its fire wakes `id` (a one-shot script that fails instead wakes it
 * with the escalation); firing, pausing or deleting ends it. A recurring trigger never counts: it would keep `id` under
 * way forever. A prompt run wakes a new conversation, not its creator.
 */
export function wakesOnce(
  a: Pick<Automation, 'enabled' | 'schedule' | 'script' | 'subscribers'>,
  id: number,
  standing: Record<string, number>,
): boolean {
  if (!a.enabled || !(a.script ? a.script.once : a.schedule?.kind === 'at')) return false
  return a.subscribers.some((s) => (typeof s === 'number' ? s : standing[s.slice(1)]) === id)
}
export type CreateArgs = {
  name: string
  schedule?: string | Schedule
  ask?: string
  event?: { name: string; where?: Record<string, string | number | boolean> }
  condition?: {
    metric: 'context'
    of: string
    above: number
    cooldownMs?: number
    /** 0 removes it. */
    idleFor?: number
  }
  once?: boolean
  secrets?: string[]
  prompt?: string
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  subscribers?: Subscriber[]
  scope?: 'user' | 'project'
  slug?: string
  /** A project script's standing agent to wake on every machine, `@name`; default `@ultimate`. */
  to?: string
  key?: string
}
export type Args = Partial<CreateArgs> & {
  action: string
  id?: string
  runId?: string
  to?: string
  lines?: number
  reason?: string
}
export type Manifest = { name: string; ask: string; once: boolean; secrets?: string[]; to: string }
/** A standing agent's name as a subscriber or target: `@ultimate`. */
export const STANDING = /^@[a-zA-Z0-9_-]+$/
export type Effect = { id: string; action: string; previousPid?: number }
export const isSlug = (id: string) => /^[a-z][a-z0-9-]{0,62}$/.test(id) && !(id in Object.prototype)
export const isId = (id: string) => /^A[1-9]\d*$/.test(id) || isSlug(id)

/** Only stdout has a protocol; stderr never fires an automation. */
export function fireText(line: string, stdout: boolean): string | undefined {
  return stdout && /^FIRE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
/** DONE takes effect only when the script exits 0. */
export function doneText(line: string, stdout: boolean): string | undefined {
  return stdout && /^DONE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
/** Keep both bounds even for a single very long output line. */
export function trimLog(text: string): string {
  const lines = text.split('\n').slice(-2001).join('\n')
  const bytes = Buffer.from(lines)
  return bytes.length > 256 * 1024 ? bytes.subarray(-256 * 1024).toString('utf8') : lines
}

/** The task kind of an automation's prompt run, which owns the run's conversation. */
export const RUN_TASK = 'ultimate.automation-run'
