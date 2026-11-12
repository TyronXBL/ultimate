/** The machine in the browser: the heavy-work queue, resources with an hour of history, and who uses them. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * Who a group of processes belongs to, in the user's terms:
 * - `host`: a project's Ultimate (its supervisor, server and helpers);
 * - `job`: a heavy-work queue job that holds the slot (its process group and everything it started);
 * - `lander`: a landing's checks;
 * - `work`: anything else a conversation runs in its worktree or a project's checkout, outside the queue (a bash or
 *   light background command, its children): what loads the machine without waiting its turn;
 * - `preview`: a preview or scratch Ultimate server, and what it runs;
 * - `browser`: a Chromium a host started (the browser and screenshot tools);
 * - `automation`: an automation's script;
 * - `system`: everything not started by an Ultimate on this machine, by program.
 */
export type OwnerKind =
  | 'host'
  | 'job'
  | 'lander'
  | 'work'
  | 'preview'
  | 'browser'
  | 'automation'
  | 'system'

/** One owner's processes now. */
export type Owner = {
  /** Stable across samples: kind, project and conversation (or program). */
  key: string
  kind: OwnerKind
  /** The project's name, as the queue names it (its folder's name). */
  project?: string
  /** The conversation whose worktree it runs in, or that queued it. */
  conversation?: number
  /** A queue job's id (`QueueJob.id`). */
  job?: string
  /** What it runs, short: a queue label, `node vitest`, `chromium`, `A8`. Never a full command line. */
  label: string
  /** CPU over the last sample interval, in cores (1 = one core busy). */
  cpu: number
  rssMiB: number
  processes: number
  /** When its oldest process started (ms). */
  since: number
}

/** Why a job waits, best known. */
export type WaitReason =
  /** Behind the job just ahead of it, running or waiting. */
  | { kind: 'behind'; label: string; from: string }
  /** First in line, but RAM would drop below the floor. */
  | { kind: 'ram'; availableMiB: number; needMiB: number; floorMiB: number; reservedMiB?: number }
  /** First in line while the one-minute load is at or above the core count. */
  | { kind: 'load'; load: number; cores: number }
  /** First in line and nothing stops it: it starts at its next look (every 5 s). */
  | { kind: 'next' }
  /** The queue's file was removed: nothing starts until running jobs announce themselves again. */
  | { kind: 'settling'; until: number }

/** A job in the heavy-work queue, as `lib/slot.ts` reads it. */
export type QueueJob = {
  id: string
  /** Its command, shortened by the queue. */
  label: string
  /** Who asked, as the queue says it: `#202077 in ultimate`. */
  from: string
  project?: string
  conversation?: number
  /** When it asked for the slot. */
  at: number
} & (
  | {
      /** Holding the slot; `measuring` while an unknown command is measured on probation (#227574) until `until`. */
      state: 'running' | 'measuring'
      since: number
      until?: number
      /** Its process group now, when it is one of its own. */
      cpu?: number
      rssMiB?: number
    }
  | { state: 'waiting'; position: number; reason: WaitReason }
)

/** A place temporary files fill: `$TMPDIR` on disk, `/tmp` in RAM on some machines. */
export type TempUse = {
  name: string
  path: string
  sizeMiB: number
  usedMiB: number
  /** On a RAM file system (tmpfs): what it holds is memory too. */
  ram: boolean
}

/** One look at the machine. */
export type Sample = {
  at: number
  /** One-minute load average. */
  load: number
  /** CPU in use, in cores, by owner kind. */
  cpu: Partial<Record<OwnerKind, number>>
  availableMiB: number
  swapUsedMiB: number
  /** Jobs holding the slot, and waiting for it. */
  running: number
  waiting: number
}

/**
 * Something that needs attention, for the status-line chip and the dashboard's header. Swap is no pressure of its own:
 * a small swap sits nearly full for days on a healthy machine; the RAM and load it comes with are.
 */
export type Pressure =
  | { kind: 'ram'; availableMiB: number; floorMiB: number; below: boolean }
  /** The one-minute load is at least one and a half times the cores: more than one heavy job's worth. */
  | { kind: 'load'; load: number; cores: number }
  | { kind: 'temp'; name: string; usedMiB: number; sizeMiB: number }
  /** Work outside the queue uses more than a core. */
  | { kind: 'outside'; cores: number }

export type MachineState = {
  now: number
  /** The project this host serves: its jobs link to their conversations. */
  project: string
  cores: number
  totalMiB: number
  swapTotalMiB: number
  /** `memory.minAvailableMiB`; unset while the floor is off. */
  floorMiB?: number
  /** Samples after `since` (the last hour without it), oldest first. History lives in the host's memory only. */
  samples: Sample[]
  queue: QueueJob[]
  /** By CPU, then memory: the largest few, and every preview and browser. `more` counts the rest. */
  owners: Owner[]
  more: { owners: number; cpu: number; rssMiB: number }
  temp: TempUse[]
  pressure: Pressure[]
}

/**
 * `{ since? }` → the machine now and the samples after `since`. Calling it keeps the sampler fast (every 3 s) for 20 s;
 * otherwise it samples every 15 s.
 */
export const StateAction = actionRef<{ since?: number }, MachineState>('machine', 'state', {
  global: true,
})

export type MachineSummary = { running: number; waiting: number; pressure: Pressure[] }

/** → the queue's length and what needs attention, from the latest sample: the status-line chip's poll. */
export const SummaryAction = actionRef<null, MachineSummary>('machine', 'summary', { global: true })
