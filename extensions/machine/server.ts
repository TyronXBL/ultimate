/**
 * Machine: samples this machine (load, memory, swap, temp folders, who uses the CPU and RAM) and reads the heavy-work
 * queue, keeping an hour of history in this process's memory. Every 15 s on its own, every 3 s while a dashboard asks.
 */
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { emptyMemory, look } from './sample.ts'
import type { MachineState, Sample } from './refs.ts'
import { StateAction, SummaryAction } from './refs.ts'

/** How often the machine is sampled while nobody looks, and while a dashboard does. */
const SLOW_MS = 15_000
const FAST_MS = 3000
/** A dashboard asks every few seconds; this long after its last ask nobody looks any more. */
const VIEW_MS = 20_000
/** The history kept: an hour, every sample of the last 10 minutes and one per `SLOW_MS` before. */
const HOUR_MS = 60 * 60_000
const DETAIL_MS = 10 * 60_000

/** `samples` with `next` added, older than an hour dropped, and fast samples older than 10 minutes thinned. */
export function retain(samples: Sample[], next: Sample) {
  const kept: Sample[] = []
  for (const sample of samples) {
    if (next.at - sample.at > HOUR_MS) continue
    const last = kept.at(-1)
    if (last && next.at - sample.at > DETAIL_MS && sample.at - last.at < SLOW_MS) continue
    kept.push(sample)
  }
  kept.push(next)
  return kept
}

type Shared = {
  memory: ReturnType<typeof emptyMemory>
  samples: Sample[]
  state?: Omit<MachineState, 'samples' | 'now'>
  viewedAt: number
  looking?: Promise<void>
}
// The history outlives a reload of this facet, never a restart of the host.
const sharedOf = (host: ExtensionHost) =>
  host.resource('machine.history', (): Shared => ({
    memory: emptyMemory(),
    samples: [],
    viewedAt: 0,
  }))

/** Sample now, unless a look is under way: then its result. */
function lookNow(host: ExtensionHost, shared: Shared) {
  shared.looking ??= look(shared.memory, {
    userHome: host.userHome,
    projectRoot: host.projectRoot,
  })
    .then(({ sample, state }) => {
      shared.samples = retain(shared.samples, sample)
      shared.state = state
    })
    .catch((error: unknown) => console.error('machine: sampling failed:', error))
    .finally(() => {
      shared.looking = undefined
    })
  return shared.looking
}

export default function machine(host: ExtensionHost) {
  const shared = sharedOf(host)
  // Ticks every 3 s and looks when a sample is due: at once on the first tick, then fast while viewed, else slow.
  const timer = setInterval(() => {
    const every = Date.now() - shared.viewedAt < VIEW_MS ? FAST_MS : SLOW_MS
    // Half a tick of slack, so a 3 s tick never skips a 3 s sample.
    if (Date.now() - (shared.samples.at(-1)?.at ?? 0) >= every - FAST_MS / 2)
      // oxlint-disable-next-line typescript/no-floating-promises -- lookNow logs a failed look and never rejects.
      void lookNow(host, shared)
  }, FAST_MS)
  timer.unref()
  host.onClose(async () => {
    clearInterval(timer)
    await shared.looking
  })
  return defineExtension({ name: 'machine' })
}

export const actions = {
  state: implementAction(StateAction, async (args, { host }) => {
    const shared = sharedOf(host)
    const since =
      args && typeof args === 'object' && 'since' in args && typeof args.since === 'number'
        ? args.since
        : 0
    const asleep = Date.now() - shared.viewedAt >= VIEW_MS
    shared.viewedAt = Date.now()
    // The first ask after a quiet spell gets a fresh look; the sampler goes fast from its next tick on.
    if (asleep || !shared.state) await lookNow(host, shared)
    if (!shared.state) throw new Error('The machine could not be sampled; see the server log')
    return {
      ...shared.state,
      now: Date.now(),
      samples: shared.samples.filter((sample) => sample.at > since),
    }
  }),
  summary: implementAction(SummaryAction, (_args, { host }) => {
    const { samples, state } = sharedOf(host)
    const last = samples.at(-1)
    return {
      running: last?.running ?? 0,
      waiting: last?.waiting ?? 0,
      pressure: state?.pressure ?? [],
    }
  }),
}

/** The dashboard asks every 3 s and the status-line chip every 15 s. */
export const pollActions = ['state', 'summary']
