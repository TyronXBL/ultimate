/**
 * The `background` tool: a local shell command run in the background, niced, in its own process group. The call returns
 * at once; a durable task waits for the command and wakes the calling conversation once with a `background.result`
 * card. The shell writes the output and the exit code to files, so a command outlives a host restart and its result is
 * still delivered.
 */
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { groupAlive, readPidFile, spawnGroup, stopGroup } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { BackgroundResult } from './refs.ts'

type Input = { to: number; cwd: string; command: string; timeout: number; home: string }
type Checkpoint =
  | { phase: 'start' }
  | { phase: 'poll'; pid: number; began: number }
  | { phase: 'deliver'; result: BackgroundResult }

/**
 * The group's leader. The command runs in a bash of its own, so any command text parses as it would in the bash tool,
 * and its own syntax errors land in the log. Once it ends, the leader records the exit code and stays alive (`exec`
 * keeps its pid and start time), so the pid file still proves the group is ours: the task then stops the whole group,
 * leader included, with TERM and KILL after a grace, before it reports. A host that never comes back to it gets an hour.
 */
const LEADER = `exec >>"$BACKGROUND_LOG" 2>&1
bash -c "$BACKGROUND_COMMAND"
echo $? > "$BACKGROUND_STATUS"
exec sleep 3600`

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
    const lines = Buffer.from(buffer.toString('utf8').split('\n').slice(-40).join('\n'))
    // Cut at the start of a character: a UTF-8 continuation byte is 10xxxxxx.
    let start = Math.max(0, lines.length - 4096)
    while (start < lines.length && (lines[start] & 0xc0) === 0x80) start++
    return lines.subarray(start).toString('utf8')
  } finally {
    await handle.close()
  }
}
/** Look often at first, then every 15 s: a long run costs few checkpoints. */
const pollMs = (elapsed: number) => Math.min(15_000, Math.max(3000, elapsed / 10))

const Run = defineTask<Input, Checkpoint, null>({
  name: 'background.run',
  version: 1,
  initial: () => ({ phase: 'start' }),
  phases: {
    start: async (task, runtime, ctx) => {
      const files = paths(task)
      await mkdir(join(task.input.home, 'background'), { recursive: true })
      // A rerun after a crash between spawning and the poll checkpoint stops the group the first attempt started.
      const left = await readPidFile(files.pid)
      if (left) await stopGroup(left, { pidFile: files.pid })
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
    },
    poll: async (task, runtime, ctx) => {
      const { pid, began } = task.state.checkpoint
      const files = paths(task)
      /** Stop the whole group, through the pid file that proves it ours; a note when part of it is left. */
      const stop = async () => {
        const stopped = await stopGroup(pid, { pidFile: files.pid }).then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        await rm(`${files.pid}.start`, { force: true })
        await rm(files.pid, { force: true })
        // A leader killed from outside cannot be verified any more, so its group is not signalled; say so.
        return groupAlive(pid)
          ? `${stopped ?? 'Its leader is gone'}: processes of group ${pid} still run; stop them with kill -- -${pid}`
          : undefined
      }
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
      // Read before anything is stopped: stopping the leader ends a group whose code is already recorded.
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
      await (
        await runtime.conversation(task.input.to as ConversationId, ctx)
      )?.submit(
        {
          type: 'input',
          requestId: `background.result:${task.id}`,
          content: `Background command ${result.outcome}${exit} after ${result.seconds} s: ${result.command}\nFull log: ${result.log}${result.note ? `\n${result.note}` : ''}${result.tail ? `\n${result.tail}` : ''}`,
          entry: { kind: 'background.result', data: result },
          whenBusy: 'followUp',
        },
        ctx,
      )
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        ctx,
      )
    },
  },
  // Concluding the conversation aborts its background tasks: the command stops and nobody is woken.
  abort: async (task, runtime, ctx) => {
    const { pid } = paths(task)
    const recorded = await readPidFile(pid)
    if (recorded) await stopGroup(recorded, { pidFile: pid })
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  },
})

export default function backgroundExtension(host: Pick<ExtensionHost, 'projectRoot' | 'home'>) {
  return defineExtension({
    name: 'background',
    tasks: [Run],
    tools: [
      defineTool({
        name: 'background',
        description:
          'Run a local shell command (a covering test file, a build, any long command) in the background, niced, in the directory bash runs in. Returns immediately; you are woken once with a result card: exit code, duration, the last 40 lines of output and the full log path. The command keeps running across your turns and Stop; concluding the conversation stops it. Use it instead of waiting on a long bash call or a hand-rolled nohup.',
        parameters: Type.Object({
          command: Type.String(),
          timeout: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: 86400,
              description: 'Seconds before the command is stopped; default 3600.',
            }),
          ),
        }),
        // Not replay-safe (the default): an interrupted call is never rerun, so it starts at most one command.
        async execute(args, api, ctx) {
          const cwd = (await api.agent(ctx)).cwd ?? host.projectRoot
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
          const text = `Started in the background in ${cwd}. You will be woken once with its result; keep working or end your turn.`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
