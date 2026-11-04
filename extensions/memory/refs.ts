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
  /** What this Ultimate runs, by RSS, listed while available RAM is within 1 GiB of the floor. */
  users: MemoryUser[]
}

/** → the floor, available RAM and, close to the floor, the largest process groups this Ultimate started. */
export const StateAction = actionRef<null, MemoryState>('memory', 'state')
