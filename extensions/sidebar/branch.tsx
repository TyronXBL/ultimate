/** Where a branch stands, as its sidebar row shows it: in flight or landed, its state word, and its work so far. */
import { useEffect, useRef, useState } from 'react'
import { useAction, useDocOf, useEvents } from '@/sdk'
import { isBusy } from '../../lib/activity.ts'
import type { Activity } from '../../lib/activity.ts'
import { waitsOnUser } from '../../lib/message-state.ts'
import { branchStanding } from '../../lib/standing.ts'
import type { Standing } from '../../lib/standing.ts'
import { Committed } from '../coding-tools/ui.tsx'
import { MessagesDoc, conversationState, emptyMessages } from '../messages/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { ProgressAction, RecentLandingsAction, useWorkspaceIndex } from '../workspaces/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import { useActivity, useConcludedSince, useOverview } from '../conversations/ui.tsx'
import { workOf } from './work.ts'

/**
 * Where each branch stands (`lib/standing.ts`), by the lander's index, durable landing events and the messages log.
 * Its work is under way while it or an owned conversation below it is busy
 * (`useActivity`, with `parked` the runs a pause holds).
 */
export function useStandings(
  conversations: readonly ConversationSummary[],
  parked?: ReadonlySet<number>,
) {
  const index = useWorkspaceIndex()
  const recent = useAction(RecentLandingsAction, null)
  const landingEvents = recent.data ?? []
  const outcomeKey = Object.entries(index.results)
    .map(([id, result]) => `${id}:${result.outcome}:${result.sha ?? ''}`)
    .join(',')
  useEffect(() => {
    // A new lander result may have aged out of the index's retained results; refresh the durable event fallback.
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void recent.refetch()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- outcomeKey captures the index changes that matter.
  }, [outcomeKey, recent.refetch])
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const concludedSince = useConcludedSince()
  const activity = useActivity(parked)
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const busy = new Set<number>()
  for (const conversation of conversations) {
    if (!isBusy(activity(conversation.id))) continue
    let current: ConversationSummary | undefined = conversation
    // Up through owned subagents: an ownerless branch has its own standing.
    while (current) {
      busy.add(current.id)
      if (current.parentConversationId === undefined || current.ownerTaskId === undefined) break
      current = byId.get(current.parentConversationId)
    }
  }
  return (branch: Pick<ConversationSummary, 'id' | 'inputAt'>) =>
    branchStanding(
      {
        id: branch.id,
        inputAt: branch.inputAt,
        busy: busy.has(branch.id),
        concluded: concludedSince(branch.id) === Infinity,
        asks: log.messages.some(waitsOnUser(branch.id)),
      },
      index,
      landingEvents,
    )
}

/** A branch state's tone. */
export type BranchTone = 'failed' | 'success' | 'brand' | 'waiting' | 'paused' | 'quiet'

/**
 * Where an open branch stands, in a word or two, and how loud to say it: its `standing` while the lander has it, else
 * its conversation state by `activity`, which counts its subagents' runs as working.
 */
export function useBranchState(
  conversation: ConversationSummary,
  standing: Standing,
  activity: Activity,
  phase: { word: string; waiting: boolean } | undefined,
): { label: string; tone: BranchTone } {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const runState = useOverview()[conversation.id]?.runState
  const primary = useDocOf(1, StandingDoc)?.ultimate
  const concludedSince = useConcludedSince()(conversation.id)
  if (standing === 'landing') return { label: 'landing', tone: 'success' } as const
  if (standing === 'submitted') return { label: 'submitted', tone: 'success' } as const
  const state = conversationState(
    { id: conversation.id, kind: 'other', activity, runState, primary, concludedSince },
    log,
  )
  // A pause holds its run: nothing of it executes until Play.
  if (state === 'paused') return { label: 'paused', tone: 'paused' } as const
  if (state === 'working')
    return {
      label: phase && !phase.waiting ? phase.word : 'working',
      tone: 'brand',
    } as const
  if (state === 'waits') return { label: 'waits on you', tone: 'waiting' } as const
  if (state === 'awaiting') return { label: 'awaiting @ultimate', tone: 'waiting' } as const
  if (state === 'failed') return { label: 'failed', tone: 'failed' } as const
  return { label: 'idle', tone: 'quiet' } as const
}

/** The text colour of each tone. */
export const tones: Record<BranchTone, string> = {
  failed: 'text-error',
  success: 'text-success',
  brand: 'text-brand',
  waiting: 'text-warning',
  paused: 'text-warning',
  quiet: 'text-muted-foreground/70',
}

/**
 * Each open branch's work so far, read once for all of them. It is read again only when something can have changed it:
 * an agent commits (`coding-tools.committed`), a worktree changes in the index, or a branch's run ends (edits happen in
 * runs). Never on a timer, nor when a run starts: each read runs git per worktree on the host.
 */
export function useFlightWork(branches: ConversationSummary[]) {
  const ids = branches.filter((branch) => branch.workspace?.state === 'ready').map((b) => b.id)
  const progress = useAction(
    ProgressAction,
    { ids },
    { enabled: ids.length > 0, onError: () => {} },
  )
  const { refetch } = progress
  // A worktree becoming ready or going changes `ids`, which refetches by itself.
  const commit = useEvents({ events: [Committed], limit: 1 })?.[0]?.id
  const busy = branches.filter((branch) => branch.busy).map((branch) => branch.id)
  // Counts the runs that ended: a branch that was working is not anymore.
  const [runs, setRuns] = useState({ busy, ended: 0 })
  if (busy.join() !== runs.busy.join())
    setRuns({
      busy,
      ended: runs.ended + (runs.busy.some((id) => !busy.includes(id)) ? 1 : 0),
    })
  const { ended } = runs
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (ids.length > 0) void refetch()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a changed id set refetches in useAction itself
  }, [commit, ended, refetch])
  const byId = new Map((progress.data ?? []).map((item) => [item.id, item]))
  return new Map(
    branches.map((branch) => [
      branch.id,
      workOf(branch.id, branch.workspace?.branch, byId.get(branch.id)),
    ]),
  )
}
