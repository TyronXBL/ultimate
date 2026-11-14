/**
 * The `ci` tool: the full CI of a committed tip, in the background, on the PC runner when this machine has a `pc` remote
 * (`pc.ts`), else on the fork's GitHub Actions. The call returns at once; a durable task runs the suites on the PC, or
 * pushes `ci/<sha>-<task>` (or waits for a run of the commit already under way), looks at the run until it ends and
 * deletes the ref, then wakes the calling conversation once with a `ci.result` card. A PC that gives no verdict hands over to GitHub. It never runs the suites on this machine: an
 * unreachable GitHub is a result too.
 */
import { obj } from '@earendil-works/pi-schema'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { ConversationsApi } from '../../../extensions/conversations/api.ts'
import type { UnderwaySource } from '../../../extensions/conversations/api.ts'
import { WorkspacesApi } from '../../../extensions/workspaces/api.ts'
import { liveTasks } from '../../../lib/tasks.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import {
  gatePlan,
  git,
  jobResult,
  pollMs,
  repository,
  runOf,
  runsOf,
  runState,
  runVerdict,
  secretsIn,
} from './github.ts'
import type { CiResult, Failure } from './refs.ts'
import { pcHost, runOnPc } from './pc.ts'
import type { Suite } from './pc.ts'

/** The fork the lander pushes to (`lander.push`); its Actions run `.github/workflows/ci.yml` on `ci/**`. */
const REMOTE = 'fork'
/** A pushed ref whose run has not appeared by then, or a GitHub that fails this long, ends the task. */
const PATIENCE_MS = 5 * 60_000
/** A run still not finished this long after its push or the start of the wait (stuck in a queue) ends the task too. */
const RUN_LIMIT_MS = 60 * 60_000
/** A PC run not finished by then hands over to GitHub. */
const PC_LIMIT_MS = 30 * 60_000

type Input = { to: number; cwd: string; sha: string }
/**
 * `pc`: why the PC runner gave no verdict, once it was tried; GitHub runs it then, and the card says why. `run`: the run
 * of the commit already under way that `poll` waits for instead of pushing its own ref; `pushed` is then when the wait
 * began.
 */
type Checkpoint =
  | { phase: 'start'; pc?: string }
  | { phase: 'pc'; host: string }
  | { phase: 'poll'; ref: string; pushed: number; failing?: number; pc?: string; run?: number }
  | { phase: 'deliver'; result: CiResult }

/**
 * A conversation's CI runs under way, each a `job` until it ends: it submits its result in its `deliver` phase, so from
 * then on the result counts (as input or a run), not the run.
 */
export const runs: UnderwaySource = {
  name: 'ci',
  underway: async (tx, id) =>
    (await liveTasks(tx, 'ci.run', id)).map((task) => ({
      kind: 'job',
      delivering: (task.state as { checkpoint?: Checkpoint }).checkpoint?.phase === 'deliver',
    })),
}
/** The note a GitHub result carries when the PC was tried first. */
const handedOver = (pc: string | undefined) =>
  pc && `PC runner: ${pc}; handed over to GitHub Actions`
/** The suites the PC runs: what the fork's workflow runs. */
const SUITES: Suite[] = ['check', 'test', 'test:e2e']

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
const deliver = (result: CiResult) => ({
  status: 'running' as const,
  checkpoint: { phase: 'deliver' as const, result },
})
/** The task's own ref, `t` apart from the gate's `ci/<sha>-<n>`; the same on every rerun of the task. */
const refOf = (task: { id: number; input: Input }) => `ci/${task.input.sha}-t${task.id}`
/** Mark each of `failures` that also failed at other branches' landings (the lander's record, without `to`'s own). */
async function attachEarlier(
  host: Pick<ExtensionHost, 'need'>,
  to: number,
  failures: Failure[],
  ctx: Context,
) {
  try {
    const repeated = await host
      .need(WorkspacesApi)
      .failing({ tests: failures.map((failure) => failure.title), except: to }, ctx)
    for (const failure of failures) {
      const earlier = repeated.find((item) => item.test === failure.title)
      if (earlier)
        failure.earlier = {
          landings: earlier.landings.length,
          branches: earlier.branches.slice(0, 5),
        }
    }
  } catch {
    // The run's result is what counts: without the lander's history its failures just carry none.
  }
}
/** Delete `ref` from the fork; a ref already gone is fine. Resolves a note for the card when it stays behind. */
const drop = (cwd: string, ref: string) =>
  git(cwd, ['push', '-q', REMOTE, '--delete', ref]).then(
    () => undefined,
    (error: unknown) =>
      /remote ref does not exist/.test(describe(error))
        ? undefined
        : `${ref} could not be deleted from the fork: ${describe(error)}`,
  )

/** What the model reads with the card: the outcome and, on failure, the failing tests. */
function summary(result: CiResult) {
  const sha = result.sha.slice(0, 7)
  const time = result.seconds === undefined ? '' : ` in ${result.seconds} s`
  const note = result.reason ? ` (${result.reason})` : ''
  const where = result.runner ? ` on ${result.runner}` : `: ${result.url}`
  if (result.conclusion === 'success') return `CI passed for ${sha}${time}${where}${note}`
  if (result.conclusion === 'failure' || result.conclusion === 'cancelled')
    return [
      `CI ${result.conclusion === 'failure' ? 'failed' : 'was cancelled'} for ${sha}${time}${where}${note}`,
      ...result.failures.map((failure) => {
        const earlier = failure.earlier
          ? ` (also failed in ${failure.earlier.landings} earlier ${failure.earlier.landings === 1 ? 'landing' : 'landings'}: ${failure.earlier.branches.map((id) => `#${id}`).join(' ')})`
          : ''
        return `FAIL ${failure.title}: ${failure.message}${earlier}`
      }),
    ].join('\n')
  if (result.conclusion === 'timeout') return `CI timed out for ${sha}: ${result.reason}`
  return `CI did not run for ${sha}: ${result.reason}`
}

function createCiRun(extension: Pick<ExtensionHost, 'need'>) {
  return defineTask<Input, Checkpoint, null>({
    name: 'ci.run',
    version: 1,
    initial: () => ({ phase: 'start' }),
    phases: {
      // Pushing the same sha to the same ref again changes nothing, so a rerun of this phase after a crash is harmless.
      start: async (task, runtime, ctx) => {
        const { cwd, sha } = task.input
        const { pc } = task.state.checkpoint
        const ref = refOf(task)
        let next
        try {
          const leaks = await secretsIn(cwd, sha, REMOTE)
          // The PC goes first, before any GitHub call: it needs no GitHub at all.
          const host = leaks.length || pc !== undefined ? undefined : await pcHost(cwd)
          const repo = leaks.length || host ? '' : await repository(cwd, REMOTE)
          // The gate's own rule: a run under way is waited for, a pass counts only when no run of the commit failed.
          const plan = repo ? gatePlan(await runsOf(cwd, repo, sha), sha) : undefined
          if (leaks.length)
            next = deliver({
              sha,
              conclusion: 'refused',
              reason: `possible secrets in ${leaks.join(', ')}; nothing was pushed`,
              jobs: [],
              failures: [],
            })
          else if (plan?.kind === 'reuse') {
            // A rerun after a crash may find the run its own push started: its ref goes too.
            const left = await drop(cwd, ref)
            next = deliver({
              sha,
              conclusion: 'success',
              url: plan.run.html_url,
              jobs: (await runState(cwd, repo, plan.run.id)).jobs.map(jobResult),
              failures: [],
              reason: [handedOver(pc), left ?? 'this commit already passed CI']
                .filter(Boolean)
                .join('; '),
            })
          } else if (host)
            next = { status: 'running' as const, checkpoint: { phase: 'pc' as const, host } }
          else {
            // A run under way is waited for, not pushed again; after a crash it may be the one this task's push started,
            // whose ref `poll` deletes at the end.
            const run = plan?.kind === 'wait' ? { run: plan.run.id } : undefined
            if (!run) await git(cwd, ['push', '-q', REMOTE, `${sha}:refs/heads/${ref}`])
            const pushed = runtime.now()
            next = {
              status: 'sleeping' as const,
              until: pushed + (await pollMs(cwd, repo)),
              checkpoint: { phase: 'poll' as const, ref, pushed, ...run, ...(pc ? { pc } : {}) },
            }
          }
        } catch (error) {
          // A prior invocation may have crashed after pushing, even if this one failed before reaching the push.
          const left = await drop(cwd, ref)
          next = deliver({
            sha,
            conclusion: 'unreachable',
            reason: [handedOver(pc), describe(error), left].filter(Boolean).join('; '),
            jobs: [],
            failures: [],
          })
        }
        await runtime.commit(() => next, ctx)
      },
      // A rerun after a crash runs the suites again; a PC still busy with the first attempt hands over to GitHub.
      pc: async (task, runtime, ctx) => {
        const { cwd, sha } = task.input
        const { host } = task.state.checkpoint
        const limit = AbortSignal.timeout(PC_LIMIT_MS)
        const run = await runOnPc(
          cwd,
          host,
          sha,
          SUITES,
          () => undefined,
          ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, limit]) : limit,
        )
        // An aborted task (its conversation concluded, the host stopping) commits nothing: only the PC's own deadline,
        // or no verdict from it, hands over to GitHub.
        if (ctx.abortSignal?.aborted) return
        if (run.outcome === 'unavailable') {
          await runtime.commit(
            () => ({
              status: 'running',
              checkpoint: { phase: 'start', pc: run.reason ?? `${host} gave no verdict` },
            }),
            ctx,
          )
          return
        }
        const failures = run.outcome === 'failed' ? run.failures : []
        if (failures.length) await attachEarlier(extension, task.input.to, failures, ctx)
        await runtime.commit(
          () =>
            deliver({
              sha,
              conclusion: run.outcome === 'passed' ? 'success' : 'failure',
              runner: host,
              seconds: run.seconds,
              jobs: run.jobs,
              failures,
            }),
          ctx,
        )
      },
      // Only reads GitHub until the run ends; deleting the ref twice is harmless.
      poll: async (task, runtime, ctx) => {
        const { cwd, sha } = task.input
        const { failing, ...checkpoint } = task.state.checkpoint
        const { ref, pushed, pc, run: watched } = checkpoint
        const now = runtime.now()
        const end = async (result: Omit<CiResult, 'sha' | 'ref'>) => {
          const left = await drop(cwd, ref)
          const reason = [handedOver(pc), result.reason, left].filter(Boolean).join('; ')
          // A run waited for ran on another ref than the task's own, which it never pushed.
          return deliver({
            sha,
            ...(watched === undefined ? { ref } : {}),
            ...result,
            ...(reason ? { reason } : {}),
          })
        }
        let next
        try {
          const repo = await repository(cwd, REMOTE)
          // One call a poll either way; the jobs are read once the run has ended.
          const run =
            watched === undefined
              ? (await runsOf(cwd, repo, sha, ref, 1))[0]
              : await runOf(cwd, repo, watched, 1)
          if (run?.status === 'completed') {
            const state = await runState(cwd, repo, run.id)
            const { conclusion, seconds, failures, notStarted } = await runVerdict(
              cwd,
              repo,
              state.run,
              state.jobs,
            )
            if (failures.length) await attachEarlier(extension, task.input.to, failures, ctx)
            next = await end({
              url: state.run.html_url,
              conclusion,
              ...(notStarted
                ? {
                    reason: `GitHub Actions did not start the jobs, so nothing was tested: ${notStarted}`,
                  }
                : {}),
              ...(seconds === undefined ? {} : { seconds }),
              jobs: state.jobs.map(jobResult),
              failures,
            })
          } else if (!run && now - pushed > PATIENCE_MS)
            next = await end({
              conclusion: 'no-run',
              reason: `no Actions run started for ${ref} within 5 min`,
              jobs: [],
              failures: [],
            })
          else if (now - pushed > RUN_LIMIT_MS)
            next = await end({
              ...(run ? { url: run.html_url } : {}),
              conclusion: 'timeout',
              reason: `the run had not finished 60 min after ${watched === undefined ? 'the push' : 'the wait began'}`,
              jobs: [],
              failures: [],
            })
          else
            next = {
              status: 'sleeping' as const,
              until: now + (await pollMs(cwd, repo)),
              checkpoint,
            }
        } catch (error) {
          const since = failing ?? now
          if (now - since > PATIENCE_MS)
            next = await end({
              conclusion: 'unreachable',
              reason: describe(error),
              jobs: [],
              failures: [],
            })
          else
            next = {
              status: 'sleeping' as const,
              until: now + 60_000,
              checkpoint: { ...checkpoint, failing: since },
            }
        }
        await runtime.commit(() => next, ctx)
      },
      // The request id makes a second submit after a crash find the first.
      deliver: async (task, runtime, ctx) => {
        const { result } = task.state.checkpoint
        const to = task.input.to as ConversationId
        const conversation = await runtime.conversation(to, ctx)
        await runtime.commit(async (tx) => {
          if (conversation)
            await conversation.submit(
              tx,
              await extension.need(ConversationsApi).resultIn(tx, to, {
                type: 'input',
                requestId: `ci.result:${task.id}`,
                content: summary(result),
                entry: { kind: 'ci.result', data: result },
                whenBusy: 'steer',
              }),
            )
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      },
    },
    // A concluded conversation stops its run's polling (Stop leaves background tasks running); the ref goes with it.
    // From `start` too: a crash between the push and the poll checkpoint leaves the task there with its ref pushed.
    abort: async (task, runtime, ctx) => {
      const left = await drop(task.input.cwd, refOf(task))
      // Nobody is woken for an aborted run, so a ref that stayed behind is reported to the host instead.
      if (left) runtime.report(new Error(left))
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'aborted', reason: left } }),
        ctx,
      )
    },
  })
}

export default function ciExtension(
  host: Pick<ExtensionHost, 'need' | 'harness' | 'projectRoot' | 'onOpen' | 'onClose'>,
) {
  const CiRun = createCiRun(host)
  let unregister: (() => void) | undefined
  host.onOpen(async () => {
    unregister = host.need(ConversationsApi).registerUnderway(runs)
  })
  host.onClose(async () => unregister?.())
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
          "Run this repository's full CI (check, unit tests, e2e) for your committed HEAD in the background, on the PC runner when one is configured, else on the fork's GitHub Actions, instead of running the suites on this machine. Returns at once; its result card (passed or failed, the failing tests, timings) steers your current run after its tool round, or wakes you when idle. Refuses a checkout with uncommitted changes: commit first, in its own tool round.",
        parameters: obj({}),
        // Not replay-safe (the default): an interrupted call is never rerun, so it starts at most one run.
        async execute(_args, api, ctx) {
          const cwd = await checkout(api.conversationId, ctx)
          // A `git commit` in the same tool round raced this call five times (#147838, #151003, #156344, #166097): CI
          // tested the HEAD before it. Staged, unstaged and untracked changes all refuse; HEAD is read after the check,
          // so a commit that finished before it is the one tested. The result still names the exact sha it tested.
          const dirty = await git(cwd, ['status', '--porcelain', '--untracked-files=normal'])
          if (dirty) {
            const paths = dirty.split('\n').map((line) => line.trim())
            throw new Error(
              `Uncommitted changes in ${cwd}, so CI would not test them: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}. Commit first, in its own tool round, then call ci again.`,
            )
          }
          const sha = await git(cwd, ['rev-parse', 'HEAD'])
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
          const text = `CI started for ${sha.slice(0, 7)} in ${cwd}. Its result steers you or wakes you in about 2–10 minutes; keep working or end your turn.`
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
