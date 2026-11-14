/**
 * The `background` tool: a local shell command run in the background, niced, in its own process group. The call returns
 * at once; a durable task waits for the command and wakes the calling conversation once with a `background.result`
 * card. The shell writes the output and the exit code to files, so a command outlives a host restart and its result is
 * still delivered. A heavy command (tests, checks, installs, builds) waits in the machine's heavy-work queue
 * (`lib/slot.ts`) for its turn and for RAM above the floor (`memory.minAvailableMiB`); a light one starts at once.
 * With CPU admission on (`cpu.maxLoadPerCore`, `lib/cpu.ts`), every command queues and waits for load: one whose text
 * names nothing heavy is measured on probation and holds the slot while it uses more than a core.
 */
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId, PhaseHandler } from '@earendil-works/pi-durable'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  admitRam,
  checkRam,
  commandNeedMiB,
  describeShort,
  listUsers,
  memoryUsers,
  RAM_POLL_MS,
  RAM_WAIT_MS,
} from '../../lib/memory.ts'
import {
  heavyNow,
  sessionCpuMs,
  holdsSlot,
  measuring,
  observe,
  PROBATION_MS,
  LIGHT_FOR_MS,
  sessionMembers,
} from '../../lib/cpu.ts'
import type { Observation } from '../../lib/cpu.ts'
import {
  groupAlive,
  identify,
  readPidFile,
  spawnGroup,
  stopGroup,
} from '../../lib/process-group.ts'
import {
  describeForced,
  describeWait,
  enterSlot,
  heavySlot,
  heavyJobsSetting,
  holdSlot,
  maxHeavyJobs,
  peekEntry,
  reclaimSlot,
  slotLimits,
  releaseSlot,
  SLOT_ENV,
  SLOT_POLL_MS,
  slotLabel,
  slotWait,
} from '../../lib/slot.ts'
import type { SlotClaim, SlotLimits } from '../../lib/slot.ts'
import { describeOom, jobScope, readUsage, shellWords } from '../../lib/job-scope.ts'
import { readRemoteStatus, REMOTE_ENV, remoteCommand, remoteRunner } from '../../lib/remote-job.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { liveTasks } from '../../lib/tasks.ts'
import { describeWhere } from './where.ts'
import type { BackgroundResult, RanWhere } from './refs.ts'
import { ConversationsApi } from '../conversations/api.ts'
import type { UnderwaySource } from '../conversations/api.ts'

type Input = { to: number; cwd: string; command: string; timeout: number; home: string }
/** The project's remote runner on `host` gave no result for this command (`reason`), so it runs here. */
type Unavailable = { host: string; reason: string }
type Checkpoint =
  | { phase: 'start'; unavailable?: Unavailable }
  /**
   * The project's remote runner (`lib/remote-job.ts`) runs it on `host`: a light process here, outside the queue. It ends
   * in a result when the runner says the command ran, and back at `start` with `unavailable` when it says anything else.
   */
  | { phase: 'remote'; pid: number; began: number; host: string }
  /**
   * Waits since `since`: a queued command in line, `ramSince` since it is next but RAM is short, `pressureSince` since it
   * is next but waits for load the queue does not cause; a light one for RAM above the floor. `waiting` says why, for
   * the Tasks panel.
   */
  | {
      phase: 'wait'
      since: number
      ramSince?: number
      pressureSince?: number
      waiting?: string
      unavailable?: Unavailable
    }
  /**
   * Runs; a queued command is in the queue as `identity` (its leader's start time), after `queued` ms in line. A heavy
   * one holds the slot; an unknown one (its text names nothing heavy) holds it as `observed` says. `forced` says it
   * started under load it waited out in vain.
   */
  | {
      phase: 'poll'
      pid: number
      began: number
      slot?: {
        identity: string
        queued: number
        observed?: Observation
        forced?: string
        /** Why the queue ends it: decided and recorded at one look, done at the next. */
        stopping?: string
      }
      unavailable?: Unavailable
    }
  | { phase: 'deliver'; result: BackgroundResult }

/**
 * The group's leader. The command runs in a bash of its own, so any command text parses as it would in the bash tool,
 * and its own syntax errors land in the log. Once it ends, the leader records the exit code and stays alive, so the pid
 * file still proves the group is ours: the task then stops the whole group, leader included, with TERM and KILL after a
 * grace, before it reports. Should no host come within an hour, the leader drains its group itself, the same way and
 * itself last, so nothing the command started outlives its leader. `scope` (`jobScope`, as shell words) runs the
 * command in a systemd scope of its own with hard limits; the leader stays outside it.
 */
const leader = (scope: string) => `exec >>"$BACKGROUND_LOG" 2>&1
${scope && `${scope} `}bash -c "$BACKGROUND_COMMAND"
echo $? > "$BACKGROUND_STATUS"
sleep 3600
trap '' TERM
kill -TERM 0
sleep 3
kill -KILL 0`

const deliver = (result: BackgroundResult) => ({
  status: 'running' as const,
  checkpoint: { phase: 'deliver' as const, result },
})
const paths = (task: { id: number; input: Input }) => {
  const base = join(task.input.home, 'background', String(task.id))
  return {
    pid: `${base}.pid`,
    log: `${base}.log`,
    status: `${base}.status`,
    usage: `${base}.usage`,
    remote: `${base}.remote`,
  }
}
/** The exit code the leader recorded, or undefined while it has not. */
const exitCode = (file: string) =>
  readFile(file, 'utf8').then(
    (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined),
    // No status file yet: the command still runs, or its leader never got to write one.
    () => undefined,
  )
/** `bytes` from the first byte that starts a UTF-8 character: a continuation byte is 10xxxxxx. */
const whole = (bytes: Buffer) => {
  let start = 0
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start)
}
/** The last 40 lines of the log, at most 4 KB. Only its end is read: a command may write gigabytes. */
async function tail(log: string) {
  const handle = await open(log, 'r').catch(
    // The command may not have opened the log yet.
    () => undefined,
  )
  if (!handle) return ''
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 64 * 1024)
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length)
    const lines = Buffer.from(whole(buffer).toString('utf8').split('\n').slice(-40).join('\n'))
    return whole(lines.subarray(-4096)).toString('utf8')
  } finally {
    await handle.close()
  }
}
/**
 * A conversation's commands under way, each a `job` until it ends: it submits its result in its `deliver` phase, so from
 * then on the result counts (as input or a run), not the job.
 */
export const jobs: UnderwaySource = {
  name: 'background',
  underway: async (tx, id) =>
    (await liveTasks(tx, 'background.run', id)).map((task) => ({
      kind: 'job',
      delivering: (task.state as { checkpoint?: Checkpoint }).checkpoint?.phase === 'deliver',
    })),
}

/**
 * What of a stopped command's session still runs outside its group (`timeout` and `setsid` start groups of their own,
 * which a group stop does not reach), said on its card: the queue no longer counts it (review of #227574).
 */
async function survivors(sid: number, queued: boolean) {
  const left = await sessionMembers(sid)
  return left.length
    ? `${left.length} of its processes run on outside its group (started under timeout or setsid)${queued ? ', so the heavy-work queue no longer counts them' : ''}; check them with ps -s ${sid} -o pid,pgid,etime,args before stopping anything.`
    : undefined
}

/** Look often at first, then every 15 s: a long run costs few checkpoints. */
const pollMs = (elapsed: number) => Math.min(15_000, Math.max(3000, elapsed / 10))

/** The queue's id of a task's command: unique on the machine, the same across restarts. */
const slotId = (task: { id: number; input: Input }) => `${task.input.home}:background:${task.id}`
/** Whether a command goes through the heavy-work queue: a heavy one, or any with CPU admission on. */
const queues = (need: number, limits: SlotLimits) => need > 0 || limits.cpu !== undefined

/**
 * Stop a command's whole group through the pid file that proves it ours, which goes with it; what it returns goes on the
 * card. A leader killed from outside proves nothing any more, and a group id may since name another group: nothing is
 * signalled, the card says so.
 */
const stopJob = (pid: number, pidFile: string, queued: boolean) =>
  stopGroup(pid, { pidFile }).then(
    async () =>
      groupAlive(pid)
        ? `Its leader was stopped from outside, so group ${pid} was not stopped; check what still runs in it with ps -eo pid,pgid,lstart,args before stopping anything.`
        : await survivors(pid, queued),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

function createRun(
  host: Pick<ExtensionHost, 'userHome' | 'need' | 'projectRoot' | 'projectSettings'>,
) {
  const from = (to: number) => `#${to} in ${basename(host.projectRoot)}`
  /** This machine's remote runner for the project, when it has one. */
  const runner = async () => remoteRunner(host.userHome, await host.projectSettings())
  const claimOf = (task: { id: number; input: Input }, at: number): SlotClaim => ({
    id: slotId(task),
    kind: commandNeedMiB(task.input.command) ? 'heavy' : 'unknown',
    at,
    label: slotLabel(task.input.command),
    from: from(task.input.to),
  })
  /** Start the command, or wait for its turn and RAM first; `wait` comes back here every look. */
  const begin: PhaseHandler<
    Input,
    Extract<Checkpoint, { phase: 'start' | 'wait' }>,
    Checkpoint,
    null,
    object
  > = async (task, runtime, ctx) => {
    const files = paths(task)
    const { checkpoint } = task.state
    const since = checkpoint.phase === 'wait' ? checkpoint.since : runtime.now()
    const need = commandNeedMiB(task.input.command)
    const limits = await slotLimits(host.userHome)
    // A rerun after a crash between spawning and the poll checkpoint stops the group the first attempt started and
    // starts it again: a light command at once, as before the floor existed (that attempt already ran, and its own RAM
    // was just freed), a heavy one through the queue: in its place when it had waited before, else at the end of the line.
    const left = await readPidFile(files.pid)
    if (left) await stopGroup(left, { pidFile: files.pid })
    const scope = await jobScope(need, files.usage)
    /** Start `command` under a leader, in `scoped` (a job scope as shell words, or none), with `env` added. */
    const start = (command: string, scoped: string, env: Record<string, string>) => {
      const group = spawnGroup('nice', ['-n', '10', '/bin/sh', '-c', leader(scoped)], {
        cwd: task.input.cwd,
        pidFile: files.pid,
        env: {
          ...process.env,
          BACKGROUND_COMMAND: command,
          BACKGROUND_LOG: files.log,
          BACKGROUND_STATUS: files.status,
          ...env,
        },
      })
      if (!group.child.pid) throw new Error('Could not start the background command')
      return group.child.pid
    }
    const spawn = () =>
      start(
        task.input.command,
        shellWords(scope ?? []),
        // What it starts belongs to its place: a nested heavy job never queues behind it.
        queues(need, limits) ? { [SLOT_ENV]: slotId(task) } : {},
      )
    const { unavailable } = checkpoint
    await mkdir(join(task.input.home, 'background'), { recursive: true })
    await rm(files.status, { force: true })
    await rm(files.usage, { force: true })
    // The project's remote runner first, once: it only sends the checkout and relays the output, so it starts at once,
    // outside the queue and RAM admission. A command back from it (`unavailable`) runs here like any other.
    const remote = checkpoint.phase === 'start' && !unavailable ? await runner() : undefined
    const there = remote && remoteCommand(task.input.command, task.input.cwd, remote.commands)
    if (remote && there) {
      await rm(files.remote, { force: true })
      const began = runtime.now()
      const pid = start(remote.runner, '', {
        [REMOTE_ENV.host]: remote.host,
        [REMOTE_ENV.command]: there,
        [REMOTE_ENV.status]: files.remote,
      })
      await runtime.commit(
        () => ({
          status: 'sleeping',
          until: began + pollMs(0),
          checkpoint: { phase: 'remote', pid, began, host: remote.host },
        }),
        ctx,
      )
      return
    }
    const notStarted = async (waited: number, note: string) =>
      deliver({
        command: task.input.command,
        cwd: task.input.cwd,
        outcome: 'not-started',
        exitCode: null,
        seconds: Math.round(waited / 1000),
        tail: '',
        // It never ran, so it wrote no log.
        log: '',
        note: `${note} Stop something, then start it again:\n${listUsers(await memoryUsers())}`,
      })
    const now = runtime.now()
    if (!queues(need, limits)) {
      const short = left ? undefined : await admitRam(limits.floor, 0)
      const next = !short
        ? {
            status: 'sleeping' as const,
            until: now + pollMs(0),
            checkpoint: {
              phase: 'poll' as const,
              pid: spawn(),
              began: now,
              ...(unavailable && { unavailable }),
            },
          }
        : now - since < RAM_WAIT_MS
          ? {
              status: 'sleeping' as const,
              until: now + RAM_POLL_MS,
              checkpoint: {
                phase: 'wait' as const,
                since,
                waiting: describeShort(short),
                ...(unavailable && { unavailable }),
              },
            }
          : await notStarted(now - since, `Not enough RAM: ${describeShort(short)}.`)
      await runtime.commit(() => next, ctx)
      return
    }
    const claim = claimOf(task, since)
    const entered = await enterSlot(claim, {
      limits,
      need,
      ...(checkpoint.phase === 'wait' && { pressureSince: checkpoint.pressureSince }),
      start: () => {
        const pid = spawn()
        const identity = identify(pid)
        if (!identity) throw new Error(`The background command's leader ${pid} ended at once`)
        return { pid, identity }
      },
    })
    let next
    if (entered.kind === 'started')
      next = {
        status: 'sleeping' as const,
        until: now + pollMs(0),
        checkpoint: {
          phase: 'poll' as const,
          pid: entered.holder.pid,
          began: now,
          slot: {
            identity: entered.holder.identity,
            queued: now - since,
            // Measured with CPU admission on: a known heavy one too, so one that hangs idle gives its place back.
            ...(limits.cpu !== undefined && {
              observed: need ? heavyNow(now) : measuring(now),
            }),
            ...(entered.forced && {
              forced: `It ${describeForced(entered.forced)}.`,
            }),
          },
          ...(unavailable && { unavailable }),
        },
      }
    else {
      const wait = slotWait(entered, checkpoint.phase === 'wait' ? checkpoint : {}, now)
      if (wait.kind === 'gave-up') {
        await releaseSlot(claim.id)
        next = await notStarted(
          now - since,
          `Not enough RAM after ${RAM_WAIT_MS / 60_000} min at the head of the heavy-work queue: ${describeShort(wait.short)}.`,
        )
      } else
        next = {
          status: 'sleeping' as const,
          until: now + SLOT_POLL_MS,
          checkpoint: {
            phase: 'wait' as const,
            since,
            ...wait.waited,
            waiting: describeWait(entered, now),
            ...(unavailable && { unavailable }),
          },
        }
    }
    await runtime.commit(() => next, ctx)
  }
  return defineTask<Input, Checkpoint, null>({
    name: 'background.run',
    version: 1,
    initial: () => ({ phase: 'start' }),
    phases: {
      start: begin,
      wait: begin,
      remote: async (task, runtime, ctx) => {
        const { pid, began, host: on } = task.state.checkpoint
        const files = paths(task)
        const now = runtime.now()
        const code = await exitCode(files.status)
        const late = code === undefined && now - began >= task.input.timeout * 1000
        if (code === undefined && !late && groupAlive(pid)) {
          await runtime.commit(
            () => ({
              status: 'sleeping',
              until: now + pollMs(now - began),
              checkpoint: task.state.checkpoint,
            }),
            ctx,
          )
          return
        }
        // The runner ended, ran out of time or was lost: what is left of its group stops before anything else starts.
        const note = await stopJob(pid, files.pid, false)
        const status = late ? undefined : await readRemoteStatus(files.remote)
        const ran = status?.ran && code !== undefined
        const where: RanWhere = {
          kind: 'remote',
          host: on,
          ...(status?.ran && {
            timings: {
              transferSeconds: status.transferSeconds,
              setupSeconds: status.setupSeconds,
              runSeconds: status.runSeconds,
              cpuSeconds: status.cpuSeconds,
            },
          }),
        }
        // Only a runner that says the command ran gives its result; the time limit is the command's, used up there.
        // Anything else is no result, and the command runs here: nothing it did there reached this machine.
        const next =
          ran || late
            ? deliver({
                command: task.input.command,
                cwd: task.input.cwd,
                outcome: ran ? 'finished' : 'timeout',
                exitCode: ran ? code : null,
                seconds: Math.round((now - began) / 1000),
                where,
                tail: await tail(files.log),
                log: files.log,
                ...(note && { note }),
              })
            : {
                status: 'running' as const,
                checkpoint: {
                  phase: 'start' as const,
                  unavailable: {
                    host: on,
                    reason:
                      status && !status.ran
                        ? status.reason
                        : code === undefined
                          ? 'its runner here was lost'
                          : `its runner here ended without a status (exit ${code})`,
                  },
                },
              }
        await runtime.commit(() => next, ctx)
      },
      poll: async (task, runtime, ctx) => {
        const { pid, began, slot, unavailable } = task.state.checkpoint
        const files = paths(task)
        const stop = () => stopJob(pid, files.pid, slot !== undefined)
        const result = async (
          outcome: BackgroundResult['outcome'],
          code: number | null,
          note?: string,
        ) => {
          const usage = await readUsage(files.usage, commandNeedMiB(task.input.command))
          const notes = [slot?.forced, usage?.oomKilled && describeOom(usage), note].filter(Boolean)
          // Said only where the project has a remote runner: elsewhere every command runs here.
          const where: RanWhere | undefined = unavailable
            ? { kind: 'here-after', ...unavailable }
            : (await runner())
              ? { kind: 'here' }
              : undefined
          return deliver({
            command: task.input.command,
            cwd: task.input.cwd,
            outcome,
            exitCode: code,
            seconds: Math.round((runtime.now() - began) / 1000),
            ...(slot && { queued: Math.round(slot.queued / 1000) }),
            ...(usage && { usage }),
            ...(where && { where }),
            tail: await tail(files.log),
            log: files.log,
            ...(notes.length && { note: notes.join('\n') }),
          })
        }
        const now = runtime.now()
        let next
        // The code first: once it is recorded, stopping the group is the end of a finished run, not of a running one.
        const code = await exitCode(files.status)
        if (code !== undefined) next = await result('finished', code, await stop())
        // The queue decided to end it at an earlier look, recorded before anything was signalled: replayed after a crash, it
        // ends the same way and says why. One that finished meanwhile is finished.
        else if (slot?.stopping)
          next = await result(
            'stopped',
            null,
            [await stop(), slot.stopping].filter(Boolean).join('\n'),
          )
        else if (now - began >= task.input.timeout * 1000)
          next = await result('timeout', null, await stop())
        else if (!groupAlive(pid)) {
          // The leader may have recorded its code between the two looks, then been stopped from outside.
          const late = await exitCode(files.status)
          next = await result(late === undefined ? 'lost' : 'finished', late ?? null, await stop())
        } else {
          const claim = slot && claimOf(task, began - slot.queued)
          const holder = slot && { pid, identity: slot.identity }
          // A measured command is measured at every look; it holds a place on probation and while it is heavy.
          const cpuMs = slot?.observed ? await sessionCpuMs(pid) : undefined
          const sample = { at: now, cpuMs: cpuMs ?? 0 }
          let observed =
            slot?.observed && cpuMs !== undefined ? observe(slot.observed, sample) : slot?.observed
          // Heavy without a place (busy again after it gave its place back, or light from probation and heavy later): it
          // takes a free one, before any waiter, or it ends, like a heavy bash command beside a full queue, so nothing
          // measured runs as one more than the machine's limit (#227574). Ending it is the existing, leader-verified stop
          // of its group; pausing it instead could not be made safe against crashes, lost leaders and forking chains.
          if (
            claim &&
            holder &&
            observed?.kind === 'reclaiming' &&
            (await reclaimSlot(claim, holder, await maxHeavyJobs(host.userHome)))
          )
            observed = observe(observed, sample, PROBATION_MS, true)
          if (observed?.kind === 'reclaiming' && slot) {
            // Recorded first, ended at the next look a second later: a crash between the two ends it the same way.
            next = {
              status: 'sleeping' as const,
              until: now + 1000,
              checkpoint: {
                phase: 'poll' as const,
                pid,
                began,
                slot: {
                  ...slot,
                  observed,
                  stopping: `The heavy-work queue ended it: it used more than a core without a place in the queue (it gave its place back after ${LIGHT_FOR_MS / 60_000} min idle, or was light at first) while every place was taken. Partial output is above; files it was writing may be incomplete. Run it again with the same call: it waits in line for a place.`,
                },
                ...(unavailable && { unavailable }),
              },
            }
          } else {
            // Said again at every look: after the queue's file was removed, this puts the job back before anyone starts.
            if (claim && holder) {
              if (!observed || observed.kind === 'measuring') await holdSlot(claim, holder)
              else if (holdsSlot(observed)) await heavySlot(claim, holder)
              else await releaseSlot(claim.id)
            }
            next = {
              status: 'sleeping' as const,
              // On probation it is looked at again right when its probation ends.
              until:
                now +
                (observed?.kind === 'measuring'
                  ? Math.min(pollMs(now - began), Math.max(1000, began + PROBATION_MS - now))
                  : pollMs(now - began)),
              checkpoint: {
                phase: 'poll' as const,
                pid,
                began,
                ...(slot && { slot: { ...slot, ...(observed && { observed }) } }),
                ...(unavailable && { unavailable }),
              },
            }
          }
        }
        // Its group is stopped: the next job in line may start.
        if (slot && next.checkpoint.phase === 'deliver') await releaseSlot(slotId(task))
        await runtime.commit(() => next, ctx)
      },
      deliver: async (task, runtime, ctx) => {
        const { result } = task.state.checkpoint
        const exit = result.exitCode === null ? '' : ` with exit code ${result.exitCode}`
        const ended =
          result.outcome === 'not-started'
            ? `not started after waiting ${result.seconds} s`
            : `${result.outcome}${exit} after ${result.seconds} s${result.usage ? `, peak ${result.usage.peakMiB} MiB and ${result.usage.cpuSeconds} s of CPU` : ''}${result.queued ? ` (and ${result.queued} s in line for the heavy-work slot before it)` : ''}`
        const to = task.input.to as ConversationId
        const conversation = await runtime.conversation(to, ctx)
        await runtime.commit(async (tx) => {
          if (conversation)
            await conversation.submit(
              tx,
              await host.need(ConversationsApi).resultIn(tx, to, {
                type: 'input',
                requestId: `background.result:${task.id}`,
                content: `Background command ${ended}: ${result.command}${result.where ? `\n${describeWhere(result.where)}` : ''}${result.log ? `\nFull log: ${result.log}` : ''}${result.note ? `\n${result.note}` : ''}${result.tail ? `\n${result.tail}` : ''}`,
                entry: { kind: 'background.result', data: result },
                whenBusy: 'steer',
              }),
            )
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      },
    },
    // Concluding the conversation aborts its background tasks: the command stops and nobody is woken. One that ends
    // anyway (a landing concludes without stopping it) reaches the concluded conversation as a note.
    abort: async (task, runtime, ctx) => {
      const { pid } = paths(task)
      const recorded = await readPidFile(pid)
      if (recorded) await stopGroup(recorded, { pidFile: pid })
      // Whether it waited in line or ran: the next job may start. A command that never queued has nothing to release.
      await releaseSlot(slotId(task))
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    },
  })
}

export default function backgroundExtension(
  host: Pick<
    ExtensionHost,
    'projectRoot' | 'home' | 'userHome' | 'need' | 'onOpen' | 'onClose' | 'projectSettings'
  >,
) {
  const Run = createRun(host)
  // On open, not at setup: on boot this facet loads before conversations provides the registry.
  let unregister: (() => void) | undefined
  host.onOpen(async () => {
    unregister = host.need(ConversationsApi).registerUnderway(jobs)
  })
  host.onClose(async () => unregister?.())
  return defineExtension({
    name: 'background',
    tasks: [Run],
    tools: [
      defineTool({
        name: 'background',
        description:
          'Run a local shell command (a covering test file, a build, any long command) in the background, niced, in the directory bash runs in. A heavy command (tests, checks, installs, builds, a server) queues machine-wide for the heavy-work slot (up to the machine limit of heavy jobs at once, default one) and starts by itself in order once a place is free and RAM allows; the answer says its place and what it waits for. Returns immediately; its result card (exit code, duration, the last 40 lines of output and the full log path) steers your current run after its tool round, or wakes you when idle. Never sleep or poll for it. The command keeps running across your turns and Stop; concluding the conversation stops it. Use it instead of waiting on a long bash call or a hand-rolled nohup. Where the project has a remote runner, a command made only of the check and test invocations the project lists runs on that machine first, and here if it gives no result; the result card says where it ran.',
        parameters: obj({
          command: str(),
          timeout: opt(
            num({
              minimum: 1,
              maximum: 86400,
              description: 'Seconds before the command is stopped; default 3600.',
            }),
          ),
        }),
        // Not replay-safe (the default): an interrupted call is never rerun, so it starts at most one command.
        async execute(args, api, ctx) {
          const cwd = (await api.agent(ctx)).cwd ?? host.projectRoot
          const need = commandNeedMiB(args.command)
          const limits = await slotLimits(host.userHome)
          const remote = await remoteRunner(host.userHome, await host.projectSettings())
          /** The host of the project's remote runner, when it tries this command first. */
          const sent =
            remote && remoteCommand(args.command, cwd, remote.commands) ? remote.host : undefined
          // Looked at before the task exists, so neither its place in line nor its admission counts against it.
          const peek =
            !sent && queues(need, limits)
              ? await peekEntry({ id: '', at: Date.now() }, { limits, need })
              : undefined
          const short = sent
            ? undefined
            : peek
              ? peek.kind === 'ram' && peek.short
              : await checkRam(limits.floor, need)
          await api.commit(
            (tx) =>
              tx.createTask(
                Run,
                {
                  to: api.conversationId,
                  cwd,
                  command: args.command,
                  timeout: args.timeout ?? 3600,
                  home: host.home,
                },
                {
                  conversationId: api.conversationId,
                  ownership: { kind: 'conversation' },
                  background: true,
                },
              ),
            ctx,
          )
          const { warning } = await heavyJobsSetting(host.userHome)
          const after = `Its result steers you or wakes you once; keep working or end your turn, never sleep or poll for it.${warning ? ` ${warning}` : ''}`
          const measured = `Its command names nothing known to be heavy, so it takes a place in the heavy-work queue and is measured for its first ${PROBATION_MS / 1000} s: above one core it counts as heavy and keeps the place until it ends or calms down, otherwise it gives the place back and runs on as light.`
          const text = sent
            ? `Sent to ${sent} first: the project runs this command on its remote runner, on a copy of ${cwd} as it is now. If ${sent} gives no result (off, busy, lost half-way), the command runs here instead, through the heavy-work queue like any other; the result card says where it ran. ${after}`
            : peek?.kind === 'waiting'
              ? `Queued, ${describeWait(peek)}. It starts in ${cwd} by itself, in order, once the slot is free; it shows in the Tasks panel while it waits.${need ? '' : ` ${measured}`} ${after}`
              : peek?.kind === 'cpu'
                ? `Queued: ${describeWait({ ...peek, pressureSince: undefined })}. It starts in ${cwd} by itself once the load falls; it shows in the Tasks panel while it waits.${need ? '' : ` ${measured}`} ${after}`
                : peek?.kind === 'ram' && need
                  ? `Queued: ${describeWait(peek)}. It starts in ${cwd} by itself once enough is free, or gives up after ${RAM_WAIT_MS / 60_000} min. ${after}`
                  : short
                    ? `Waiting for RAM: ${describeShort(short)}. It starts in ${cwd} once enough is free, looking every ${RAM_POLL_MS / 1000} s for up to ${RAM_WAIT_MS / 60_000} min. ${after}`
                    : need
                      ? `Starting in the background in ${cwd}: the heavy-work slot is free, unless a job that asked at the same moment takes it first, and then this one waits its turn by itself. ${after}`
                      : peek
                        ? `Starting in the background in ${cwd}. ${measured} ${after}`
                        : `Started in the background in ${cwd}. ${after}`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
