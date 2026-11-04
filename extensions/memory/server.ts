/**
 * Memory: the RAM floor's state for the status-line chip. The gates themselves live where jobs start (background,
 * lander, instance, bash) and share `lib/memory.ts`.
 */
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { availableMiB, memoryFloor, memoryUsers } from '../../lib/memory.ts'
import { StateAction } from './refs.ts'

export default defineExtension({ name: 'memory' })

/** How close to the floor available RAM gets before the chip shows, in MiB. */
const MARGIN = 1024

export const actions = {
  state: implementAction(StateAction, async (_args, { host }) => {
    const floor = memoryFloor(await host.projectSettings())
    if (floor === undefined) return { users: [] }
    const available = await availableMiB()
    if (available === undefined) return { floor, users: [] }
    return {
      floor,
      available,
      users: available < floor + MARGIN ? await memoryUsers() : [],
    }
  }),
}

/** The status-line chip asks every 15 seconds. */
export const pollActions = ['state']
