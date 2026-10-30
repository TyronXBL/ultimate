/** Where a branch stands, as its sidebar row shows it: in flight or landed, its state word, and its work so far. */
import { useEffect, useRef } from 'react'
import { useAction, useDocOf, useEvents } from '@/sdk'
import { Committed } from '../coding-tools/ui.tsx'
import { MessagesDoc, conversationState, emptyMessages } from '../messages/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { ProgressAction, useWorkspaceIndex } from '../workspaces/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import { useConcludedSince, useOverview } from '../conversations/ui.tsx'
import { workOf } from './work.ts'

/** When a branch last landed: its latest landed submission's last step. */
export function landedAt(index: ReturnType<typeof useWorkspaceIndex>, id: number) {
  let at: number | undefined
  for (const result of Object.values(index.results))
    if (result.conversationId === id && result.outcome === 'landed')
      at = Math.max(at ?? 0, result.steps.at(-1)?.at ?? result.at)
  return at
}

/**
 * Whether a branch is still in flight: started and neither concluded (the caller leaves those out) nor landed since
 * its latest input. A branch that lands and then gets new work is in flight again.
 */
export function inFlight(
  conversation: ConversationSummary,
  index: ReturnType<typeof useWorkspaceIndex>,
) {
  if (conversation.busy) return true
  if (index.queue.some((item) => item.conversationId === conversation.id)) return true
  const landed = landedAt(index, conversation.id)
  return landed === undefined || (conversation.inputAt ?? 0) > landed
}

/** A branch state's tone. */
export type BranchTone = 'failed' | 'success' | 'brand' | 'waiting' | 'paused' | 'quiet'

/** Where an open branch stands, in a word or two, and how loud to say it. */
export function useBranchState(
  conversation: ConversationSummary,
  working: boolean,
  phase: { word: string; waiting: boolean } | undefined,
  parked = false,
): { label: string; tone: BranchTone } {
  const index = useWorkspaceIndex()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const runState = useOverview()[conversation.id]?.runState
  const primary = useDocOf(1, StandingDoc)?.ultimate
  const concludedSince = useConcludedSince()(conversation.id)
  const queued = index.queue.find((item) => item.conversationId === conversation.id)
  if (queued?.state === 'landing') return { label: 'landing', tone: 'success' } as const
  if (queued) return { label: 'submitted', tone: 'success' } as const
  // A pause holds its run: nothing of it executes until Play.
  if (parked) return { label: 'paused', tone: 'paused' } as const
  // The sidebar's one conversation state; `working` also counts its subagents' runs.
  const state = working
    ? 'working'
    : conversationState(
        { id: conversation.id, kind: 'other', runState, primary, concludedSince },
        log,
      )
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
  waiting: 'text-amber-700 dark:text-amber-300',
  paused: 'text-warning',
  quiet: 'text-muted-foreground/70',
}

/**
 * Each open branch's work so far, read once for all of them. It is read again only when something can have changed it:
 * an agent commits (`coding-tools.committed`), a worktree changes in the index, or a branch's run starts or ends
 * (edits happen in runs). Never on a timer.
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
  const runs = branches.map((branch) => `${branch.id}:${branch.busy ? 1 : 0}`).join(',')
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (ids.length > 0) void refetch()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a changed id set refetches in useAction itself
  }, [commit, runs, refetch])
  const byId = new Map((progress.data ?? []).map((item) => [item.id, item]))
  return new Map(
    branches.map((branch) => [
      branch.id,
      workOf(branch.id, branch.workspace?.branch, byId.get(branch.id)),
    ]),
  )
}
