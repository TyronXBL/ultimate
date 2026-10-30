import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnGroup, stopGroup, groupAlive, readPidFile } from '../../lib/process-group.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import type { BackgroundResult } from './refs.ts'

type Input = { to: number; cwd: string; command: string; timeout: number; home: string }
type Checkpoint =
  | { phase: 'start' }
  | { phase: 'poll'; pid: number; began: number }
  | { phase: 'deliver'; result: BackgroundResult }
const deliver = (value: BackgroundResult) => ({
  status: 'running' as const,
  checkpoint: { phase: 'deliver' as const, result: value },
})
const paths = (task: { id: number; input: Input }) => {
  const base = join(task.input.home, 'background', String(task.id))
  return { pid: `${base}.pid`, log: `${base}.log`, status: `${base}.status` }
}
async function makeResult(
  task: { id: number; input: Input },
  outcome: BackgroundResult['outcome'],
  exitCode: number | null,
  began: number,
): Promise<BackgroundResult> {
  const files = paths(task)
  let text = ''
  try {
    text = await readFile(files.log, 'utf8')
  } catch {
    /* command may not have opened the log yet */
  }
  const tail = text.split('\n').slice(-40).join('\n').slice(-4096)
  return {
    command: task.input.command,
    cwd: task.input.cwd,
    outcome,
    exitCode,
    seconds: Math.max(0, Math.round((Date.now() - began) / 1000)),
    tail,
    log: files.log,
  }
}
const Run = defineTask<Input, Checkpoint, null>({
  name: 'background.run',
  version: 1,
  initial: () => ({ phase: 'start' }),
  phases: {
    start: async (task, runtime, ctx) => {
      const files = paths(task)
      await mkdir(join(task.input.home, 'background'), { recursive: true })
      const began = runtime.now()
      await rm(files.status, { force: true })
      const script = `trap 'code=$?; printf "%s\\n" "$code" > "$STATUS"; exit "$code"' EXIT; ${task.input.command}; code=$?; trap - EXIT; printf "%s\\n" "$code" > "$STATUS"; exit "$code"`
      const group = spawnGroup(
        'nice',
        ['-n', '10', '/bin/sh', '-c', `exec >>"$LOG" 2>&1; export STATUS; ${script}`, 'background'],
        {
          cwd: task.input.cwd,
          pidFile: files.pid,
          env: { ...process.env, LOG: files.log, STATUS: files.status },
        },
      )
      if (!group.child.pid) throw new Error('Could not start background command')
      await runtime.commit(
        () => ({
          status: 'sleeping',
          until: began + 3000,
          checkpoint: { phase: 'poll', pid: group.child.pid!, began },
        }),
        ctx,
      )
    },
    poll: async (task, runtime, ctx) => {
      const { pid, began } = task.state.checkpoint
      const files = paths(task)
      let code: number | undefined
      try {
        const value = (await readFile(files.status, 'utf8')).trim()
        if (/^-?\d+$/.test(value)) code = Number(value)
      } catch {
        /* still running or lost */
      }
      let next
      if (code !== undefined) next = deliver(await makeResult(task, 'finished', code, began))
      else if (runtime.now() - began >= task.input.timeout * 1000) {
        const recorded = await readPidFile(files.pid)
        if (recorded) await stopGroup(recorded, { pidFile: files.pid })
        next = deliver(await makeResult(task, 'timeout', null, began))
      } else if (!groupAlive(pid)) next = deliver(await makeResult(task, 'lost', null, began))
      else
        next = {
          status: 'sleeping' as const,
          until: runtime.now() + 3000,
          checkpoint: { phase: 'poll' as const, pid, began },
        }
      await runtime.commit(() => next, ctx)
    },
    deliver: async (task, runtime, ctx) => {
      const { result: value } = task.state.checkpoint
      await (
        await runtime.conversation(task.input.to as ConversationId, ctx)
      )?.submit(
        {
          type: 'input',
          requestId: `background.result:${task.id}`,
          content: `${value.outcome}: ${value.command} (exit ${value.exitCode ?? 'unknown'}, ${value.seconds}s)\nLog: ${value.log}${value.tail ? `\n${value.tail}` : ''}`,
          entry: { kind: 'background.result', data: value },
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
  abort: async (task, runtime, ctx) => {
    const pid = await readPidFile(paths(task).pid)
    if (pid) await stopGroup(pid, { pidFile: paths(task).pid })
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  },
})

export default function backgroundExtension(
  host: Pick<ExtensionHost, 'need' | 'harness' | 'projectRoot' | 'home'>,
) {
  async function checkout(id: ConversationId, ctx: Context) {
    const workspaces = host.need(WorkspacesApi)
    for (let current: ConversationId | undefined = id; current !== undefined;) {
      const workspace = await workspaces.get(current, ctx)
      if (workspace) return workspace.path
      const at: ConversationId = current
      current = (await host.harness().commit((tx) => tx.conversation(at), ctx))?.owner
        ?.conversationId
    }
    return host.projectRoot
  }
  return defineExtension({
    name: 'background',
    tasks: [Run],
    tools: [
      defineTool({
        name: 'background',
        description:
          'Run a local shell command in the background. Returns immediately; you will be woken with its result, so keep working or end your turn.',
        parameters: Type.Object({
          command: Type.String(),
          timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 86400 })),
        }),
        async execute(args, api, ctx) {
          const cwd = await checkout(api.conversationId, ctx)
          const timeout = args.timeout ?? 3600
          await api.commit(
            (tx) =>
              tx.createTask(
                Run,
                { to: api.conversationId, cwd, command: args.command, timeout, home: host.home },
                {
                  conversationId: api.conversationId,
                  ownership: { kind: 'conversation' },
                  background: true,
                },
              ),
            ctx,
          )
          return {
            output: [
              {
                type: 'text',
                text: `Background task started in ${cwd}. You will be woken with the result; keep working or end your turn.`,
              },
            ],
          }
        },
      }),
    ],
  })
}
