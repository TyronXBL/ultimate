/**
 * The `ci` tool: the full CI of a committed tip on the fork's GitHub Actions, in the background. The call returns at
 * once; a durable task pushes `ci/<sha>-<task>`, looks at the run until it ends, deletes the ref and wakes the calling
 * conversation once with a `ci.result` card. It never runs the suites on this machine: an unreachable GitHub is a
 * result too.
 */
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import { WorkspacesApi } from '../../../extensions/workspaces/api.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import {
  failuresOf,
  git,
  jobResult,
  pollMs,
  repository,
  runsOf,
  runState,
  secretsIn,
} from './github.ts'
import type { CiResult } from './refs.ts'

/** The fork the lander pushes to (`lander.push`); its Actions run `.github/workflows/ci.yml` on `ci/**`. */
const REMOTE = 'fork'
/** A pushed ref whose run has not appeared by then, or a GitHub that fails this long, ends the task. */
const PATIENCE_MS = 5 * 60_000

type Input = { to: number; cwd: string; sha: string }
type Checkpoint =
  | { phase: 'start' }
  | { phase: 'poll'; ref: string; pushed: number; failing?: number }
  | { phase: 'deliver'; result: CiResult }

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
const deliver = (result: CiResult) => ({
  status: 'running' as const,
  checkpoint: { phase: 'deliver' as const, result },
})

/** What the model reads with the card: the outcome and, on failure, the failing tests. */
function summary(result: CiResult) {
  const sha = result.sha.slice(0, 7)
  const time = result.seconds === undefined ? '' : ` in ${result.seconds} s`
  if (result.conclusion === 'success') return `CI passed for ${sha}${time}: ${result.url}`
  if (result.conclusion === 'failure' || result.conclusion === 'cancelled')
    return [
      `CI ${result.conclusion === 'failure' ? 'failed' : 'was cancelled'} for ${sha}${time}: ${result.url}`,
      ...result.failures.map((failure) => `FAIL ${failure.title}: ${failure.message}`),
    ].join('\n')
  return `CI did not run for ${sha}: ${result.reason}`
}

const CiRun = defineTask<Input, Checkpoint, null>({
  name: 'ci.run',
  version: 1,
  initial: () => ({ phase: 'start' }),
  phases: {
    // Pushing the same sha to the same ref again changes nothing, so a rerun of this phase after a crash is harmless.
    start: async (task, runtime, ctx) => {
      const { cwd, sha } = task.input
      let next
      try {
        const leaks = await secretsIn(cwd, sha, REMOTE)
        const repo = await repository(cwd, REMOTE)
        const passed = leaks.length
          ? undefined
          : (await runsOf(cwd, repo, sha)).find((run) => run.conclusion === 'success')
        if (leaks.length)
          next = deliver({
            sha,
            conclusion: 'refused',
            reason: `possible secrets in ${leaks.join(', ')}; nothing was pushed`,
            jobs: [],
            failures: [],
          })
        else if (passed)
          next = deliver({
            sha,
            conclusion: 'success',
            url: passed.html_url,
            jobs: (await runState(cwd, repo, passed.id)).jobs.map(jobResult),
            failures: [],
            reason: 'this commit already passed CI',
          })
        else {
          const ref = `ci/${sha}-${task.id}`
          await git(cwd, ['push', '-q', REMOTE, `${sha}:refs/heads/${ref}`])
          const pushed = runtime.now()
          next = {
            status: 'sleeping' as const,
            until: pushed + (await pollMs(cwd, repo)),
            checkpoint: { phase: 'poll' as const, ref, pushed },
          }
        }
      } catch (error) {
        next = deliver({
          sha,
          conclusion: 'unreachable',
          reason: describe(error),
          jobs: [],
          failures: [],
        })
      }
      await runtime.commit(() => next, ctx)
    },
    // Only reads GitHub until the run ends; deleting the ref twice is harmless.
    poll: async (task, runtime, ctx) => {
      const { cwd, sha } = task.input
      const { ref, pushed, failing } = task.state.checkpoint
      const now = runtime.now()
      const drop = () =>
        git(cwd, ['push', '-q', REMOTE, '--delete', ref]).catch(
          // The result is what counts; a leftover ci/ branch only clutters the fork.
          () => undefined,
        )
      let next
      try {
        const repo = await repository(cwd, REMOTE)
        const run = (await runsOf(cwd, repo, sha, ref, 1))[0]
        if (run?.status === 'completed') {
          const state = await runState(cwd, repo, run.id)
          const failures =
            state.run.conclusion === 'success' ? [] : await failuresOf(cwd, repo, state.jobs)
          const jobs = state.jobs.map(jobResult)
          const ends = state.jobs.flatMap((job) =>
            job.completed_at ? [Date.parse(job.completed_at)] : [],
          )
          const starts = state.jobs.flatMap((job) =>
            job.started_at ? [Date.parse(job.started_at)] : [],
          )
          await drop()
          next = deliver({
            sha,
            ref,
            url: state.run.html_url,
            conclusion:
              state.run.conclusion === 'success'
                ? 'success'
                : state.run.conclusion === 'cancelled'
                  ? 'cancelled'
                  : 'failure',
            ...(starts.length && ends.length
              ? { seconds: Math.round((Math.max(...ends) - Math.min(...starts)) / 1000) }
              : {}),
            jobs,
            failures,
          })
        } else if (!run && now - pushed > PATIENCE_MS) {
          await drop()
          next = deliver({
            sha,
            ref,
            conclusion: 'no-run',
            reason: `no Actions run started for ${ref} within 5 min`,
            jobs: [],
            failures: [],
          })
        } else
          next = {
            status: 'sleeping' as const,
            until: now + (await pollMs(cwd, repo)),
            checkpoint: { phase: 'poll' as const, ref, pushed },
          }
      } catch (error) {
        const since = failing ?? now
        if (now - since > PATIENCE_MS) {
          await drop()
          next = deliver({
            sha,
            ref,
            conclusion: 'unreachable',
            reason: describe(error),
            jobs: [],
            failures: [],
          })
        } else
          next = {
            status: 'sleeping' as const,
            until: now + 60_000,
            checkpoint: { phase: 'poll' as const, ref, pushed, failing: since },
          }
      }
      await runtime.commit(() => next, ctx)
    },
    // The request id makes a second submit after a crash find the first.
    deliver: async (task, runtime, ctx) => {
      const { result } = task.state.checkpoint
      await (
        await runtime.conversation(task.input.to as ConversationId, ctx)
      )?.submit(
        {
          type: 'input',
          requestId: `ci.result:${task.id}`,
          content: summary(result),
          entry: { kind: 'ci.result', data: result },
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
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})

export default function ciExtension(host: Pick<ExtensionHost, 'need' | 'harness' | 'projectRoot'>) {
  /** The checkout a conversation works in: its own worktree, else its nearest owner's, else the project. */
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
    name: 'ci',
    tasks: [CiRun],
    tools: [
      defineTool({
        name: 'ci',
        description:
          "Run this repository's full CI (check, unit tests, e2e) on the fork's GitHub Actions for your committed HEAD, in the background, instead of running the suites on this machine. Returns at once; you are woken once with a result card (passed or failed, the failing tests, timings). Uncommitted changes are not tested.",
        parameters: Type.Object({}),
        // Not replay-safe (the default): an interrupted call is never rerun, so it starts at most one run.
        async execute(_args, api, ctx) {
          const cwd = await checkout(api.conversationId, ctx)
          const sha = await git(cwd, ['rev-parse', 'HEAD'])
          const dirty = (await git(cwd, ['status', '--porcelain'])) !== ''
          await api.commit(
            (tx) =>
              tx.createTask(
                CiRun,
                { to: api.conversationId, cwd, sha },
                {
                  conversationId: api.conversationId,
                  ownership: { kind: 'conversation' },
                  background: true,
                },
              ),
            ctx,
          )
          const text = `CI started for ${sha.slice(0, 7)} in ${cwd}. You will be woken with its result in about 2–5 minutes; keep working or end your turn.${dirty ? ' Uncommitted changes are not part of it.' : ''}`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
