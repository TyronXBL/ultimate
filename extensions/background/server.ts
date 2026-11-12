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
  describeLoad,
  heavyNow,
  sessionCpuMs,
  holdsSlot,
  measuring,
  observe,
  PROBATION_MS,
  signalSession,
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
  describeWait,
  enterSlot,
  heavySlot,
  heavyJobsSetting,
  holdSlot,
  maxHeavyJobs,
  reclaimSlot,
  peekGate,
  peekSlot,
  slotLimits,
  releaseSlot,
  SLOT_ENV,
  SLOT_POLL_MS,
  slotLabel,
} from '../../lib/slot.ts'
import type { SlotClaim } from '../../lib/slot.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { liveTasks } from '../../lib/tasks.ts'
import type { BackgroundResult } from './refs.ts'
import { ConversationsApi } from '../conversations/api.ts'
import type { UnderwaySource } from '../conversations/api.ts'

type Input = { to: number; cwd: string; command: string; timeout: number; home: string }
type Checkpoint =
  | { phase: 'start' }
  /**
   * Waits since `since`: a queued command in line, `ramSince` since it is next but RAM is short, `pressureSince` since it
   * is next but waits for load the queue does not cause; a light one for RAM above the floor. `waiting` says why, for
   * the Tasks panel.
   */
  | { phase: 'wait'; since: number; ramSince?: number; pressureSince?: number; waiting?: string }
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
        /** How long it was paused, reclaiming a place. */
        pausedMs?: number
      }
    }
  | { phase: 'deliver'; result: BackgroundResult }

/**
 * The group's leader. The command runs in a bash of its own, so any command text parses as it would in the bash tool,
 * and its own syntax errors land in the log. Once it ends, the leader records the exit code and stays alive, so the pid
 * file still proves the group is ours: the task then stops the whole group, leader included, with TERM and KILL after a
 * grace, before it reports. Should no host come within an hour, the leader drains its group itself, the same way and
 * itself last, so nothing the command started outlives its leader.
 */
const LEADER = `exec >>"$BACKGROUND_LOG" 2>&1
bash -c "$BACKGROUND_COMMAND"
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
  return { pid: `${base}.pid`, log: `${base}.log`, status: `${base}.status` }
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
/** Look often at first, then every 15 s: a long run costs few checkpoints. */
const pollMs = (elapsed: number) => Math.min(15_000, Math.max(3000, elapsed / 10))

/** The queue's id of a task's command: unique on the machine, the same across restarts. */
const slotId = (task: { id: number; input: Input }) => `${task.input.home}:background:${task.id}`

function createRun(host: Pick<ExtensionHost, 'userHome' | 'need' | 'projectRoot'>) {
  const from = (to: number) => `#${to} in ${basename(host.projectRoot)}`
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
    const spawn = () => {
      const group = spawnGroup('nice', ['-n', '10', '/bin/sh', '-c', LEADER], {
        cwd: task.input.cwd,
        pidFile: files.pid,
        env: {
          ...process.env,
          BACKGROUND_COMMAND: task.input.command,
          BACKGROUND_LOG: files.log,
          BACKGROUND_STATUS: files.status,
          // What it starts belongs to its place: a nested heavy job never queues behind it.
          ...((need > 0 || limits.cpu !== undefined) && { [SLOT_ENV]: slotId(task) }),
        },
      })
      if (!group.child.pid) throw new Error('Could not start the background command')
      return group.child.pid
    }
    await mkdir(join(task.input.home, 'background'), { recursive: true })
    await rm(files.status, { force: true })
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
    if (!need && limits.cpu === undefined) {
      const short = left ? undefined : await admitRam(limits.floor, 0)
      const next = !short
        ? {
            status: 'sleeping' as const,
            until: now + pollMs(0),
            checkpoint: { phase: 'poll' as const, pid: spawn(), began: now },
          }
        : now - since < RAM_WAIT_MS
          ? {
              status: 'sleeping' as const,
              until: now + RAM_POLL_MS,
              checkpoint: { phase: 'wait' as const, since, waiting: describeShort(short) },
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
              forced: `It started under pressure (${describeLoad(entered.forced)}) after ${Math.round(entered.forced.waited / 60_000)} min waiting for load the heavy-work queue did not cause.`,
            }),
          },
        },
      }
    else {
      // RAM short at the head of the line gives up after `RAM_WAIT_MS`, so the line behind it moves on; the line itself
      // has no limit.
      const ramSince =
        entered.kind === 'ram'
          ? checkpoint.phase === 'wait'
            ? (checkpoint.ramSince ?? now)
            : now
          : undefined
      const pressureSince = entered.kind === 'cpu' ? entered.pressureSince : undefined
      if (entered.kind === 'ram' && now - ramSince! >= RAM_WAIT_MS) {
        await releaseSlot(claim.id)
        next = await notStarted(
          now - since,
          `Not enough RAM after ${RAM_WAIT_MS / 60_000} min at the head of the heavy-work queue: ${describeShort(entered.short)}.`,
        )
      } else
        next = {
          status: 'sleeping' as const,
          until: now + SLOT_POLL_MS,
          checkpoint: {
            phase: 'wait' as const,
            since,
            ...(ramSince !== undefined && { ramSince }),
            ...(pressureSince !== undefined && { pressureSince }),
            waiting: describeWait(entered, now),
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
      poll: async (task, runtime, ctx) => {
        const { pid, began, slot } = task.state.checkpoint
        const files = paths(task)
        /** Signal the command's session, but only while its leader is still the process this task started. */
        const signal = async (held: typeof slot, name: NodeJS.Signals) => {
          if (held && identify(pid) === held.identity) await signalSession(pid, name)
        }
        /** Resume a session this task may have paused (it gave its place back, or waits for one again). */
        const resume = (held: typeof slot) =>
          held?.observed?.kind === 'released' || held?.observed?.kind === 'reclaiming'
            ? signal(held, 'SIGCONT')
            : Promise.resolve()
        /**
         * Stop the whole group through the pid file that proves it ours, which goes with it. A leader killed from outside
         * proves nothing any more, and a group id may since name another group: nothing is signalled, the card says so.
         */
        const stop = async () =>
          // A paused group gets TERM only once it runs again.
          resume(slot)
            .then(() => stopGroup(pid, { pidFile: files.pid }))
            .then(
              () =>
                groupAlive(pid)
                  ? `Its leader was stopped from outside, so group ${pid} was not stopped; check what still runs in it with ps -eo pid,pgid,lstart,args before stopping anything.`
                  : undefined,
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            )
        const result = async (
          outcome: BackgroundResult['outcome'],
          code: number | null,
          note?: string,
        ) =>
          deliver({
            command: task.input.command,
            cwd: task.input.cwd,
            outcome,
            exitCode: code,
            seconds: Math.round((runtime.now() - began) / 1000),
            ...(slot && { queued: Math.round(slot.queued / 1000) }),
            tail: await tail(files.log),
            log: files.log,
            ...((note || slot?.forced || slot?.pausedMs) && {
              note: [
                slot?.forced,
                slot?.pausedMs &&
                  `It was paused ${Math.round(slot.pausedMs / 1000)} s: it gave its place in the heavy-work queue back while idle, and when it was busy again every place was taken.`,
                note,
              ]
                .filter(Boolean)
                .join('\n'),
            }),
          })
        const now = runtime.now()
        let next
        // The code first: once it is recorded, stopping the group is the end of a finished run, not of a running one.
        const code = await exitCode(files.status)
        if (code !== undefined) next = await result('finished', code, await stop())
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
          // Busy again after it gave its place back: it runs on only with a place, paused meanwhile, so it never runs
          // as one more than the machine's limit (#227574).
          if (
            claim &&
            holder &&
            observed?.kind === 'reclaiming' &&
            (await reclaimSlot(claim, holder, await maxHeavyJobs(host.userHome)))
          )
            observed = observe(observed, sample, PROBATION_MS, true)
          // Reconciled at every look, not only on a change: a crash between a signal and the checkpoint that records it
          // must leave no job stopped, nor one running that should wait.
          if (observed?.kind === 'reclaiming') await signal(slot, 'SIGSTOP')
          else await resume(slot)
          const pausedMs =
            (slot?.pausedMs ?? 0) +
            (slot?.observed?.kind === 'reclaiming' ? now - slot.observed.last.at : 0)
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
              ...(slot && {
                slot: { ...slot, ...(observed && { observed }), ...(pausedMs && { pausedMs }) },
              }),
            },
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
            : `${result.outcome}${exit} after ${result.seconds} s${result.queued ? ` (and ${result.queued} s in line for the heavy-work slot before it)` : ''}`
        const to = task.input.to as ConversationId
        const conversation = await runtime.conversation(to, ctx)
        await runtime.commit(async (tx) => {
          if (conversation)
            await conversation.submit(
              tx,
              await host.need(ConversationsApi).resultIn(tx, to, {
                type: 'input',
                requestId: `background.result:${task.id}`,
                content: `Background command ${ended}: ${result.command}${result.log ? `\nFull log: ${result.log}` : ''}${result.note ? `\n${result.note}` : ''}${result.tail ? `\n${result.tail}` : ''}`,
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
      const { checkpoint } = task.state as { checkpoint?: Checkpoint }
      // A group this task may have paused gets TERM only once it runs again; signalled only while its leader is the one
      // the task started.
      const kind = checkpoint?.phase === 'poll' ? checkpoint.slot?.observed?.kind : undefined
      if (
        recorded &&
        checkpoint?.phase === 'poll' &&
        checkpoint.pid === recorded &&
        (kind === 'released' || kind === 'reclaiming') &&
        identify(recorded) === checkpoint.slot?.identity
      )
        await signalSession(recorded, 'SIGCONT')
      if (recorded) await stopGroup(recorded, { pidFile: pid })
      // Whether it waited in line or ran: the next job may start. A command that never queued has nothing to release.
      await releaseSlot(slotId(task))
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    },
  })
}

export default function backgroundExtension(
  host: Pick<ExtensionHost, 'projectRoot' | 'home' | 'userHome' | 'need' | 'onOpen' | 'onClose'>,
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
          'Run a local shell command (a covering test file, a build, any long command) in the background, niced, in the directory bash runs in. A heavy command (tests, checks, installs, builds, a server) queues machine-wide for the heavy-work slot (up to the machine limit of heavy jobs at once, default one) and starts by itself in order once a place is free and RAM allows; the answer says its place and what it waits for. Returns immediately; its result card (exit code, duration, the last 40 lines of output and the full log path) steers your current run after its tool round, or wakes you when idle. Never sleep or poll for it. The command keeps running across your turns and Stop; concluding the conversation stops it. Use it instead of waiting on a long bash call or a hand-rolled nohup.',
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
          const queued = need > 0 || limits.cpu !== undefined
          // Looked at before the task exists, so neither its place in line nor its admission counts against it.
          const turn = queued ? await peekSlot({ id: '', at: Date.now() }, limits.max) : undefined
          const gate = turn?.kind === 'next' ? await peekGate(limits) : undefined
          const short =
            (turn?.kind === 'next' && gate?.kind !== 'wait') || !queued
              ? await checkRam(limits.floor, need)
              : undefined
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
          const text =
            turn && turn.kind !== 'next'
              ? `Queued, ${describeWait({ kind: 'waiting', turn })}. It starts in ${cwd} by itself, in order, once the slot is free; it shows in the Tasks panel while it waits.${need ? '' : ` ${measured}`} ${after}`
              : gate?.kind === 'wait'
                ? `Queued: ${describeWait({ kind: 'cpu', gate, pressureSince: undefined })}. It starts in ${cwd} by itself once the load falls; it shows in the Tasks panel while it waits.${need ? '' : ` ${measured}`} ${after}`
                : short && need
                  ? `Queued: next in line for the heavy-work slot, waiting for memory: ${describeShort(short)}. It starts in ${cwd} by itself once enough is free, or gives up after ${RAM_WAIT_MS / 60_000} min. ${after}`
                  : short
                    ? `Waiting for RAM: ${describeShort(short)}. It starts in ${cwd} once enough is free, looking every ${RAM_POLL_MS / 1000} s for up to ${RAM_WAIT_MS / 60_000} min. ${after}`
                    : need
                      ? `Starting in the background in ${cwd}: the heavy-work slot is free, unless a job that asked at the same moment takes it first, and then this one waits its turn by itself. ${after}`
                      : queued
                        ? `Starting in the background in ${cwd}. ${measured} ${after}`
                        : `Started in the background in ${cwd}. ${after}`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
