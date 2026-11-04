/**
 * Memory: the RAM floor's state for the status-line chip. The gates themselves live where jobs start (background,
 * lander, instance, bash) and share `lib/memory.ts`.
 */
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { availableMiB, cgroupMemory, memoryFloor, memoryUsers } from '../../lib/memory.ts'
import { StateAction } from './refs.ts'

export default defineExtension({ name: 'memory' })

/** How close to the floor available RAM gets before the chip shows, in MiB. */
const MARGIN = 1024

export const actions = {
  state: implementAction(StateAction, async (_args, { host }) => {
    const floor = await memoryFloor(host.userHome)
    if (floor === undefined) return { users: [] }
    const available = await availableMiB()
    if (available === undefined) return { floor, users: [] }
    if (available >= floor + MARGIN) return { floor, available, users: [] }
    const [users, cgroup] = await Promise.all([memoryUsers(), cgroupMemory()])
    return { floor, available, near: true, users, ...(cgroup && { cgroup }) }
  }),
}

/** The status-line chip asks every 15 seconds. */
export const pollActions = ['state']
