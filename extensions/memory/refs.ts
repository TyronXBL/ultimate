/** The RAM floor in the browser: how much RAM is available and what Ultimate runs that uses it. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** A process group this Ultimate started, as `lib/memory.ts` lists it. */
export type MemoryUser = {
  pgid: number
  rssMiB: number
  processes: number
  /** The command line of the group's topmost process, shortened. */
  command: string
  cwd?: string
  name?: string
}

export type MemoryState = {
  /** `memory.minAvailableMiB`; unset while the floor is off. */
  floor?: number
  /** Available RAM in MiB; unset where it cannot be read (not Linux). */
  available?: number
  /** Available RAM is within 1 GiB of the floor, or below it: the status line shows it. */
  near?: boolean
  /** What this Ultimate runs, by RSS, listed while `near`. */
  users: MemoryUser[]
  /** The memory controller of the cgroup Ultimate runs in (MiB), when it limits memory: the hard guarantee. */
  cgroup?: { current: number; high?: number; max?: number }
}

/** → the floor, available RAM and, close to the floor, the largest process groups this Ultimate started. */
export const StateAction = actionRef<null, MemoryState>('memory', 'state', { global: true })
