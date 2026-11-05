/**
 * The `background` tool: a local shell command run in the background, niced, in its own process group. The call returns
 * at once; a durable task waits for the command and wakes the calling conversation once with a `background.result`
 * card. The shell writes the output and the exit code to files, so a command outlives a host restart and its result is
 * still delivered. Below the RAM floor (`memory.minAvailableMiB`) a heavy command waits for RAM before it starts.
 */
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId, PhaseHandler } from '@earendil-works/pi-durable'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  admitRam,
  checkRam,
  commandNeedMiB,
  describeShort,
  listUsers,
  memoryFloor,
  memoryUsers,
  RAM_POLL_MS,
  RAM_WAIT_MS,
} from '../../lib/memory.ts'
import { groupAlive, readPidFile, spawnGroup, stopGroup } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { BackgroundResult } from './refs.ts'
import { ConversationsApi } from '../conversations/api.ts'

type Input = { to: number; cwd: string; command: string; timeout: number; home: string }
type Checkpoint =
  | { phase: 'start' }
  /** Waits for RAM above the floor, since `since`. */
  | { phase: 'wait'; since: number }
  | { phase: 'poll'; pid: number; began: number }
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
/** Look often at first, then every 15 s: a long run costs few checkpoints. */
const pollMs = (elapsed: number) => Math.min(15_000, Math.max(3000, elapsed / 10))

function createRun(host: Pick<ExtensionHost, 'userHome' | 'need'>) {
  /** Start the command, or wait for RAM first; `wait` comes back here every poll. */
  const begin: PhaseHandler<
    Input,
    Extract<Checkpoint, { phase: 'start' | 'wait' }>,
    Checkpoint,
    null,
    object
  > = async (task, runtime, ctx) => {
    const files = paths(task)
    // A rerun after a crash between spawning and the poll checkpoint stops the group the first attempt started and
    // starts it again at once, as before the floor existed: that attempt already ran, so it never waits for RAM or
    // reports that the command never started. Its own RAM was just freed.
    const left = await readPidFile(files.pid)
    if (left) await stopGroup(left, { pidFile: files.pid })
    const short = left
      ? undefined
      : await admitRam(await memoryFloor(host.userHome), commandNeedMiB(task.input.command))
    if (short) {
      const { checkpoint } = task.state
      const since = checkpoint.phase === 'wait' ? checkpoint.since : runtime.now()
      const waited = runtime.now() - since
      const next =
        waited < RAM_WAIT_MS
          ? {
              status: 'sleeping' as const,
              until: runtime.now() + RAM_POLL_MS,
              checkpoint: { phase: 'wait' as const, since },
            }
          : deliver({
              command: task.input.command,
              cwd: task.input.cwd,
              outcome: 'not-started',
              exitCode: null,
              seconds: Math.round(waited / 1000),
              tail: '',
              // It never ran, so it wrote no log.
              log: '',
              note: `Not enough RAM: ${describeShort(short)}. Stop something, then start it again:\n${listUsers(await memoryUsers())}`,
            })
      await runtime.commit(() => next, ctx)
      return
    }
    await mkdir(join(task.input.home, 'background'), { recursive: true })
    await rm(files.status, { force: true })
    const began = runtime.now()
    const group = spawnGroup('nice', ['-n', '10', '/bin/sh', '-c', LEADER], {
      cwd: task.input.cwd,
      pidFile: files.pid,
      env: {
        ...process.env,
        BACKGROUND_COMMAND: task.input.command,
        BACKGROUND_LOG: files.log,
        BACKGROUND_STATUS: files.status,
      },
    })
    if (!group.child.pid) throw new Error('Could not start the background command')
    await runtime.commit(
      () => ({
        status: 'sleeping',
        until: began + pollMs(0),
        checkpoint: { phase: 'poll', pid: group.child.pid!, began },
      }),
      ctx,
    )
  }
  return defineTask<Input, Checkpoint, null>({
    name: 'background.run',
    version: 1,
    initial: () => ({ phase: 'start' }),
    phases: {
      start: begin,
      wait: begin,
      poll: async (task, runtime, ctx) => {
        const { pid, began } = task.state.checkpoint
        const files = paths(task)
        /**
         * Stop the whole group through the pid file that proves it ours, which goes with it. A leader killed from outside
         * proves nothing any more, and a group id may since name another group: nothing is signalled, the card says so.
         */
        const stop = () =>
          stopGroup(pid, { pidFile: files.pid }).then(
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
            tail: await tail(files.log),
            log: files.log,
            ...(note && { note }),
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
        } else
          next = {
            status: 'sleeping' as const,
            until: now + pollMs(now - began),
            checkpoint: { phase: 'poll' as const, pid, began },
          }
        await runtime.commit(() => next, ctx)
      },
      deliver: async (task, runtime, ctx) => {
        const { result } = task.state.checkpoint
        const exit = result.exitCode === null ? '' : ` with exit code ${result.exitCode}`
        const ended =
          result.outcome === 'not-started'
            ? `not started after waiting ${result.seconds} s for RAM`
            : `${result.outcome}${exit} after ${result.seconds} s`
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
      if (recorded) await stopGroup(recorded, { pidFile: pid })
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    },
  })
}

export default function backgroundExtension(
  host: Pick<ExtensionHost, 'projectRoot' | 'home' | 'userHome' | 'need'>,
) {
  const Run = createRun(host)
  return defineExtension({
    name: 'background',
    tasks: [Run],
    tools: [
      defineTool({
        name: 'background',
        description:
          'Run a local shell command (a covering test file, a build, any long command) in the background, niced, in the directory bash runs in. Returns immediately; its result card (exit code, duration, the last 40 lines of output and the full log path) steers your current run after its tool round, or wakes you when idle. Never sleep or poll for it. The command keeps running across your turns and Stop; concluding the conversation stops it. Use it instead of waiting on a long bash call or a hand-rolled nohup.',
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
          // Looked at before the task exists, so its own admission is not counted against it.
          const short = await checkRam(
            await memoryFloor(host.userHome),
            commandNeedMiB(args.command),
          )
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
          const text = short
            ? `Waiting for RAM: ${describeShort(short)}. It starts in ${cwd} once enough is free, looking every ${RAM_POLL_MS / 1000} s for up to ${RAM_WAIT_MS / 60_000} min; its result steers you or wakes you once either way. Keep working or end your turn; never sleep or poll for it.`
            : `Started in the background in ${cwd}. Its result steers you or wakes you once; keep working or end your turn, never sleep or poll for it.`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
