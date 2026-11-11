import type { ConversationSubject } from '../conversations/types.ts'

/** Where a conversation's checkout lives and what it lands on, in every state. */
type Checkout = {
  path: string
  branch: string
  base: string
  source: string
  target: string
}
/**
 * A conversation's checkout by state, each with only its fields; only `workspaceStep` (state.ts) changes them.
 * `landed` is the tip its last landing brought; a ready checkout's `error` says why its removal failed, a removed one's
 * what its removal left behind (a merged branch it could not delete, a foreign folder at the path).
 */
export type Workspace =
  | (Checkout & { state: 'preparing' })
  | (Checkout & { state: 'ready'; landed?: string; error?: string })
  | (Checkout & { state: 'failed'; error: string })
  /** Release decided to remove it; the removal is owed. */
  | (Checkout & { state: 'releasing'; landed?: string })
  | (Checkout & { state: 'removed'; landed?: string; error?: string })
/** One `workspace submit`, waiting for or being processed by its source's lander. */
type Submitted = {
  id: string
  conversationId: number
  source: string
  target: string
  tip: string
  /** Latest submitting conversation entry when submit was called. */
  at: number
  divergence: string
  subject?: ConversationSubject
  /** What the lander did so far, as its conversation logs it. */
  steps: LanderStep[]
}
/**
 * Queued, or landing with its current `step`. `landed` is what the submission's fast-forward landed, recorded with it
 * while landing and kept when its task ends and the entry returns to queued, so any later lander task pushes and
 * reports that. Only `queueEntryStep` (queue.ts) changes the state fields.
 */
export type QueueEntry =
  | (Submitted & { state: 'queued'; landed?: Landed })
  | (Submitted & { state: 'landing'; step?: string; landed?: Landed })
/**
 * Why a landing ran no checks: the project configures none, or its `.ultimate/settings.json` declares `declared` lander
 * checks that stay off because the user declined its setup or has not chosen yet (trust gates running them). Without
 * `declared` the file did not parse, so what it declares is unknown.
 */
export type Unchecked =
  | { reason: 'none' }
  | { reason: 'untrusted'; declared?: number; decision: 'declined' | 'undecided' }
/**
 * A submission's landing: the target moved from `base` to `sha`, which brought `commits` and `paths`; `unchecked` when no
 * check ran on it; `weight` what it added and removed.
 */
export type Landed = {
  sha: string
  base: string
  commits: string[]
  paths: string[]
  flaky: string[]
  reused?: ReusedCheck[]
  unchecked?: Unchecked
  weight?: Weight
}
/** Lines and estimated tokens a landing added and removed over the files `lib/token-weight.ts` counts. */
type Weight = { added: number; removed: number; tokens: number }
/**
 * The run whose pass a check reused instead of testing again (#205147): who ran it (`runner`), where to read it (`url`),
 * the exact commit it tested, when it finished there and how long it took.
 */
export type Reused = {
  runner: string
  url: string
  sha: string
  completedAt: number
  seconds: number
}
/** A check of a landing that reused an earlier pass, with that pass's origin. */
export type ReusedCheck = { command: string } & Reused
/**
 * A check's result: it ran and passed, ran and failed, failed and passed its rerun (`flaky`), or exited 0 reusing a
 * named earlier pass of the same commit (`reused`). Only `settleCheck` (check.ts) makes one. A result that passed
 * carries its last output line as `summary`.
 */
export type LanderCheck =
  | { command: string; result: 'passed' | 'failed' | 'flaky'; summary?: string }
  | { command: string; result: 'reused'; reused: Reused; summary?: string }
/** One row of a submission's progress: a step, or a check with its result. */
export type LanderStep = {
  step: string
  at: number
  /** The check command this step starts running; its `check` result row ends it. */
  runs?: string
  check?: LanderCheck
  /** A step the user must not miss, such as checks skipped. */
  warning?: true
}
/** How a submission ended. A push that failed after landing locally is `landed` with a `reason`. */
export type LanderOutcome = {
  outcome: 'landed' | 'failed'
  divergence?: string
  sha?: string
  /** The target's tip the landing moved from: `base..sha` is what it brought. */
  base?: string
  commits?: string[]
  paths?: string[]
  flaky?: string[]
  /** Checks that reused an earlier pass of the landed commit instead of running again, with where it came from. */
  reused?: ReusedCheck[]
  unchecked?: Unchecked
  weight?: Weight
  /** `<remote>/<target>` it was pushed to. */
  pushed?: string
  needsRestart?: boolean
  reason?: string
  /** Output tail behind the reason: conflicting paths, a check's output, git's error. */
  output?: string
  /** What the submitter does next, for a failure. */
  hint?: string
  /** Failed tests of a failed check that also failed at other branches' landings: how often, and which branches. */
  repeats?: Repeat[]
}
/** A failed test's earlier landings elsewhere: their count and the first few submitting branches, newest first. */
type Repeat = { test: string; landings: number; branches: number[] }
/**
 * A test as the lander log records its failures: one landing per submission whose check run failed it (`sank` when
 * it also failed the rerun, so the submission did not land), newest first, and the distinct submitting branches.
 */
export type FailingTest = {
  test: string
  landings: {
    submission: string
    conversationId: number
    sourceEntry?: number
    at: number
    sank: boolean
  }[]
  branches: number[]
}
/** One line of a lander conversation's log (entry kind `ultimate.lander`): a step, a check result, or the outcome. */
export type LanderEntry = {
  submission: string
  conversationId: number
  tip: string
  target: string
  at: number
  /** Submitting conversation breadcrumb, not the log timestamp. */
  sourceEntry?: number
  step?: string
  runs?: string
  check?: LanderCheck
  warning?: true
  /** On the submission's first line and its outcome. */
  subject?: ConversationSubject
} & Partial<LanderOutcome>
export type WorkspaceIndex = {
  items: Record<string, Workspace>
  queue: QueueEntry[]
  /** Live lander task per source checkout. */
  landers: Record<string, number>
  /** The lander conversation per source checkout, where its task runs and logs. */
  landerConversations: Record<string, number>
  /** Outcomes of the latest submissions by id, with their target and lander conversation, for the submitter's cards. */
  results: Record<
    string,
    LanderOutcome & {
      target: string
      tip: string
      lander: number
      steps: LanderStep[]
      conversationId?: number
      subject?: ConversationSubject
      at: number
      divergence: string
    }
  >
}
export type WorkspaceInfo = Workspace & {
  ahead: number | null
  tip: string | null
  sourceTip: string | null
  currentBranch: string | null
  sourceBranch: string | null
}
/** Checkouts by record state; ready ones by their commits (fresh: none of their own) and uncommitted changes. */
export type WorkspaceStats = Record<Workspace['state'], number> & {
  total: number
  landed: number
  ahead: number
  fresh: number
  dirty: number
}
/** Disk the worktrees directory takes: every checkout's blocks, and on btrfs the blocks they share counted once. */
export type WorkspaceDisk = { bytes: number | null; real: number | null; at: number }
export type LandResult = {
  text: string
  landed?: string
  commits?: string[]
  paths?: string[]
  files?: { path: string; added: number; removed: number }[]
  needsRestart?: boolean
}
export type SubmitResult = { text: string; id: string; position: number; lander: number }
