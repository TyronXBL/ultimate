/**
 * The bash tripwire for heavy work: a plain bash command measured using more than a core while the machine's
 * heavy-work places are taken is stopped, with the `background` call that queues it instead.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import {
  describeBehind,
  enterSlot,
  keepHeld,
  maxHeavyJobs,
  slotLabel,
  thisProcess,
} from '../../lib/slot.ts'
import {
  BASH_SAMPLE_MS,
  BASH_WINDOW_MS,
  holdsSlot,
  observe,
  sessionCpuMs,
  sessionMarked,
  sessionMembers,
  signalSession,
} from '../../lib/cpu.ts'
import type { CpuSample, Observation } from '../../lib/cpu.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** How long a heavy bash command stopped by the queue gets between TERM and KILL. */
const KILL_GRACE_MS = 3000

/** Set in a bash call's environment to an id of its own: `watchHeavy` finds the call's shell by it. */
export const BASH_CALL_ENV = 'ULTIMATE_BASH_CALL'

/**
 * Stop a running bash call from a watch: it names why and what to do instead, and gets the function that cancels the
 * call (Pi then KILLs its group), or undefined when the call is already being stopped.
 */
export type Halt = (why: string, detail: string) => (() => void) | undefined

/** CPU use in cores, from the oldest of `samples` to the newest. */
const coresOver = (samples: CpuSample[]) => {
  const first = samples[0]
  const last = samples.at(-1)!
  return Math.max(0, last.cpuMs - first.cpuMs) / Math.max(1, last.at - first.at)
}

/**
 * Watch a running bash call's session (its shell's, found by `marker` in its environment; `lib/cpu.ts` says why not
 * its process group): once it uses more than a core for `BASH_WINDOW_MS`, it is heavy work beside the tool call. It
 * then takes the heavy-work slot if nobody holds it or waits for it, and holds it to its end; otherwise it is stopped,
 * TERM to every process of the session and KILL after 3 s, with the `background` call that queues it instead. Origin:
 * #227574, where two Playwright audits ran from bash under `timeout`, one sent to the background with `&`, while the
 * queue ran its own heavy job. Returns the function that ends the watch.
 */
export function watchHeavy(
  host: Pick<ExtensionHost, 'projectRoot' | 'userHome'>,
  api: Pick<ToolExecutionApi, 'conversationId'>,
  command: string,
  marker: string,
) {
  return (halt: Halt) => {
    const began = Date.now()
    let observation: Observation = { kind: 'light', last: { at: began, cpuMs: 0 } }
    const samples: CpuSample[] = [observation.last]
    let sid: number | undefined
    let release: (() => Promise<void>) | undefined
    /** Set once it is being stopped: a look that failed half-way finishes the stop at the next one. */
    let stopping: (() => void) | undefined
    let done = false
    const look = async () => {
      sid ??= await sessionMarked(marker)
      const cpuMs = sid === undefined ? undefined : await sessionCpuMs(sid)
      if (sid === undefined || cpuMs === undefined) return
      const now = Date.now()
      samples.push({ at: now, cpuMs })
      while (samples.length > 2 && now - samples[1].at >= BASH_WINDOW_MS) samples.shift()
      // Observed as if a place were free: once heavy, the call takes one below or is stopped.
      observation = observe(observation, { at: now, cpuMs }, BASH_WINDOW_MS, true)
      if (!holdsSlot(observation)) return
      if (!stopping) {
        const decided = await admit(now)
        if (!decided) {
          // It holds a place now, or the call is already being stopped (the user's cancel, a steer).
          done = true
          return
        }
        stopping = decided
      }
      // Ours, checked right before each signal: its shell's environment holds this call's marker, or its shell is gone
      // while processes of its session live on, and a session id is never given to another session before all of them
      // have ended (review of #227574).
      const session = sid
      const ours = async () => {
        if ((await sessionMarked(marker)) === session) return true
        const members = await sessionMembers(session)
        return members.length > 0 && !members.includes(session)
      }
      if (await ours()) {
        await signalSession(session, 'SIGTERM')
        const deadline = Date.now() + KILL_GRACE_MS
        while ((await sessionMembers(session)).length && Date.now() < deadline) await sleep(100)
        if (await ours()) await signalSession(session, 'SIGKILL')
      }
      stopping()
      done = true
    }
    /** Take a place for the command now measured heavy (undefined), or prepare its stop: the function that cancels it. */
    const admit = async (now: number) => {
      const claim = {
        id: `${host.projectRoot}:bash:${randomUUID()}`,
        kind: 'heavy' as const,
        at: now,
        label: slotLabel(command),
        from: `#${api.conversationId} in ${basename(host.projectRoot)} (bash, measured)`,
      }
      // Taken only when a place is free and nobody waits for one: a bash command never jumps the line. It already runs,
      // so neither RAM nor load are asked.
      const entered = await enterSlot(claim, {
        limits: { floor: undefined, cpu: undefined, max: await maxHeavyJobs(host.userHome) },
        need: 0,
        start: thisProcess,
        queue: false,
      })
      if (entered.kind === 'started') {
        release = keepHeld(claim)
        return undefined
      }
      const holders =
        entered.kind === 'waiting' && entered.turn.kind === 'behind'
          ? `${describeBehind(entered.turn, now)} held or waited for the heavy-work slot`
          : 'the heavy-work queue settled after its file was removed'
      return halt(
        `Stopped by the heavy-work queue: it used ${coresOver(samples).toFixed(1)} cores over the last ${Math.round((now - samples[0].at) / 1000)} s while ${holders}`,
        `Every process it started got TERM, then KILL after ${KILL_GRACE_MS / 1000} s, so files it was writing may be incomplete. Heavy work runs in the queue, up to the machine's limit at once, in order; it starts by itself and its result steers or wakes you, so never sleep, poll or retry it in bash:\nbackground ${JSON.stringify({ command })}`,
      )
    }
    let looks = Promise.resolve()
    const timer = setInterval(() => {
      looks = looks.then(() =>
        done
          ? undefined
          : look().catch((error: unknown) =>
              // The next look measures again; a failed one only delays it.
              console.error('coding-tools: measuring a bash command failed:', error),
            ),
      )
    }, BASH_SAMPLE_MS)
    timer.unref()
    return async () => {
      done = true
      clearInterval(timer)
      await looks
      await release?.()
    }
  }
}
