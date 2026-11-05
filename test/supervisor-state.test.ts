import { expect, it } from 'vitest'
import {
  initialSupervisorState,
  routeMode,
  shouldExitOnStorageFailure,
  stepCorePhase,
  stepSupervisor,
} from '../lib/supervisor.ts'
import type { CorePhase, SupervisorEvent, SupervisorState } from '../lib/supervisor.ts'

type State = SupervisorState<string>
type Event = SupervisorEvent<string>
const DOWN: State = { kind: 'down', failures: 0 }
const RECOVERING = (failures: number): State => ({ kind: 'recovering', failures })
const ACTIVE: State = { kind: 'active', core: 'a' }
const SWAPPING: State = { kind: 'swapping', core: 'a' }
const RELEASED: State = { kind: 'swapping' }
const CRASHED: State = { kind: 'crashed' }
const STOPPING: State = { kind: 'stopping' }

it.each<[string, State, Event, State]>([
  ['starts from nothing', initialSupervisorState(), { type: 'recover' }, RECOVERING(0)],
  ['recovery runs once', RECOVERING(1), { type: 'recover' }, RECOVERING(1)],
  ['recovery is not started while serving', ACTIVE, { type: 'recover' }, ACTIVE],
  ['a failed boot counts', RECOVERING(1), { type: 'boot failed' }, RECOVERING(2)],
  ['three failures park on the crash page', RECOVERING(3), { type: 'parked' }, CRASHED],
  [
    'a ready core serves and clears the failures',
    RECOVERING(2),
    { type: 'started', core: 'a' },
    ACTIVE,
  ],
  // 94324ec5: a watcher retry from the parked crash page resets failures and recovers.
  ['a retry from the crash page starts over', CRASHED, { type: 'retry' }, DOWN],
  ['a watcher event while recovering is a no-op', RECOVERING(2), { type: 'retry' }, RECOVERING(2)],
  ['a watcher event while serving is a no-op', ACTIVE, { type: 'retry' }, ACTIVE],
  ['a watcher event while stopping is a no-op', STOPPING, { type: 'retry' }, STOPPING],
  ['an unexpected exit of the serving core recovers', ACTIVE, { type: 'exited', core: 'a' }, DOWN],
  ['another core exiting changes nothing', ACTIVE, { type: 'exited', core: 'b' }, ACTIVE],
  ['a swap keeps serving the old core', ACTIVE, { type: 'swap' }, SWAPPING],
  ['a second swap is refused', SWAPPING, { type: 'swap' }, SWAPPING],
  ['releasing the old core serves nothing', SWAPPING, { type: 'released' }, RELEASED],
  [
    'the new core serves',
    RELEASED,
    { type: 'started', core: 'b' },
    { kind: 'swapping', core: 'b' },
  ],
  // 083fd2a0: a swap that fails after release reacquires the old core.
  [
    'the old core is restored after a failed swap',
    RELEASED,
    { type: 'started', core: 'a' },
    SWAPPING,
  ],
  [
    'a finished swap serves the core it holds',
    { kind: 'swapping', core: 'b' },
    { type: 'swap ended' },
    { kind: 'active', core: 'b' },
  ],
  // 083fd2a0: a dead old core that cannot be reacquired recovers.
  ['a swap that ends with no core recovers', RELEASED, { type: 'swap ended' }, DOWN],
  ['a serving core dying mid-swap leaves none', SWAPPING, { type: 'exited', core: 'a' }, RELEASED],
  ['nothing starts while stopping', STOPPING, { type: 'started', core: 'a' }, STOPPING],
  ['nothing recovers while stopping', STOPPING, { type: 'recover' }, STOPPING],
  ['an exit while stopping is not a crash', STOPPING, { type: 'exited', core: 'a' }, STOPPING],
  ['stopping wins from anywhere', RECOVERING(1), { type: 'stop' }, STOPPING],
])('supervisor: %s', (_name, from, event, expected) => {
  expect(stepSupervisor(from, event)).toEqual(expected)
})

it.each<[string, State, ReturnType<typeof routeMode<string>>]>([
  ['serving core', ACTIVE, { kind: 'active', core: 'a' }],
  ['old core until released', SWAPPING, { kind: 'active', core: 'a' }],
  ['held while released', RELEASED, { kind: 'queue' }],
  ['held while booting', RECOVERING(0), { kind: 'queue' }],
  ['held before the first boot', DOWN, { kind: 'queue' }],
  ['crash page when parked', CRASHED, { kind: 'crash' }],
  ['held while stopping', STOPPING, { kind: 'queue' }],
])('routes sockets: %s', (_name, state, expected) => {
  expect(routeMode(state)).toEqual(expected)
})

it.each<[string, CorePhase, 'go' | 'release' | 'close', CorePhase, boolean]>([
  ['serves on go', 'prepared', 'go', 'serving', true],
  ['stops serving on release', 'serving', 'release', 'prepared', false],
  ['serves again on reacquire', 'prepared', 'go', 'serving', true],
  ['closes while serving', 'serving', 'close', 'closing', false],
  ['closes while prepared', 'prepared', 'close', 'closing', false],
  // A storage failure while closing must not exit before the close finishes.
  ['stays closing on go', 'closing', 'go', 'closing', false],
  ['stays closing on release', 'closing', 'release', 'closing', false],
])('core phase: %s', (_name, from, event, expected, exits) => {
  const next = stepCorePhase(from, event)
  expect(next).toBe(expected)
  expect(shouldExitOnStorageFailure(next)).toBe(exits)
})
