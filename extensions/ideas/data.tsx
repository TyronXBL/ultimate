/** The board's rows: each idea with its stage, its branch and the decisions it waits on, all read live. */
import { useEffect } from 'react'
import { useDocOf, useExtensionUiState } from '@/sdk'
import { useConcludedSince } from '../conversations/ui.tsx'
import { useRoots } from '../lineage/ui.tsx'
import { MessagesDoc, emptyMessages } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { PlanDoc } from '../plan/ui.tsx'
import { waiting } from '../questions/ui.tsx'
import { inFlight, landedAt, useFlightWork, useLandings } from '../sidebar/ui.tsx'
import type { Landing } from '../sidebar/ui.tsx'
import { useWorkspaceConversations, useWorkspaceIndex } from '../workspaces/ui.tsx'
import type { WorkspaceConversation } from '../workspaces/ui.tsx'
import { IdeasDoc } from './refs.ts'
import type { Idea } from './refs.ts'
import { stageOf } from './stage.ts'
import type { BranchFacts, Column } from './stage.ts'

export type Row = {
  idea: Idea
  column: Column
  note?: 'launching' | 'not built'
  /** Its linked branch, once @ultimate started it and while it is known. */
  branch?: WorkspaceConversation
  landed?: BranchFacts['landed']
  /** Messages about its branch that wait on the user, oldest first. */
  asks: Message[]
  /** When it last moved: the branch's latest input or answer, else when it was parked, launched or added. */
  at: number
}

/** Its latest landing, unless it got new work since: from the lander's recent results, else the roots' landing notes. */
function landingOf(
  branch: WorkspaceConversation,
  index: ReturnType<typeof useWorkspaceIndex>,
  landings: readonly Landing[],
): BranchFacts['landed'] {
  if (branch.busy) return undefined
  const at = landedAt(index, branch.id)
  if (at !== undefined && !inFlight(branch, index)) {
    const result = Object.values(index.results)
      .filter((item) => item.conversationId === branch.id && item.outcome === 'landed' && item.sha)
      .toSorted((a, b) => a.at - b.at)
      .at(-1)
    if (result?.sha) return { sha: result.sha, base: result.base, at }
  }
  const note = landings.find(
    (event) => event.from === branch.id && (event.at ?? 0) >= (branch.inputAt ?? 0),
  )
  return note ? { sha: note.sha, base: note.base, at: note.at } : undefined
}

/** Watches `branch` for its first plan epic: what tells an assessment that turned into building. */
function PlanProbe({ branch, onPlan }: { branch: number; onPlan: () => void }) {
  const planned = Object.keys(useDocOf(branch, PlanDoc)?.epics ?? {}).length > 0
  useEffect(() => {
    if (planned) onPlan()
  }, [planned, onPlan])
  return null
}

/** Every idea as a row of the board, and the probes that must be mounted for them to know about plans. */
export function useBoard() {
  const items = useDocOf(1, IdeasDoc)?.items
  const conversations = useWorkspaceConversations()
  const index = useWorkspaceIndex()
  const landings = useLandings(useRoots() ?? [])
  const concludedSince = useConcludedSince()
  const asks = waiting((useDocOf(1, MessagesDoc) ?? emptyMessages).messages).toReversed()
  // Branches seen building, kept: a reload shows them in Building at once, and a branch never goes back to assessing.
  const [started, setStarted] = useExtensionUiState<number[]>('started', [])
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const linked = (items ?? []).flatMap((idea) => {
    const branch = idea.launch?.branch === undefined ? undefined : byId.get(idea.launch.branch)
    return branch ? [branch] : []
  })
  const work = useFlightWork(linked)
  const start = (id: number) => {
    if (!started.includes(id)) setStarted([...started, id])
  }
  const committed = linked.find(
    (branch) => work.get(branch.id)?.commits && !started.includes(branch.id),
  )
  useEffect(() => {
    if (committed) start(committed.id)
  })
  const rows = (items ?? []).map((idea): Row => {
    const id = idea.launch?.branch
    const branch = id === undefined ? undefined : byId.get(id)
    const landed = branch && landingOf(branch, index, landings)
    const facts: BranchFacts | undefined =
      id === undefined
        ? undefined
        : {
            landed,
            concluded: concludedSince(id) === Infinity,
            submitted: index.queue.some((item) => item.conversationId === id),
            started: started.includes(id) || !!work.get(id)?.commits,
          }
    const activity = branch ? Math.max(branch.inputAt ?? 0, branch.answerAt ?? 0) : 0
    return {
      idea,
      ...stageOf(idea, facts),
      branch,
      landed,
      asks: id === undefined ? [] : asks.filter((message) => message.about === id),
      at: Math.max(activity, idea.parked ?? 0, idea.launch?.at ?? 0, idea.at),
    }
  })
  const probes = linked
    .filter((branch) => !started.includes(branch.id))
    .map((branch) => (
      <PlanProbe branch={branch.id} key={branch.id} onPlan={() => start(branch.id)} />
    ))
  return { loading: items === undefined, rows, probes }
}

/** The board's order within a stage: what needs you first, then what moved last. */
export const byUrgency = (a: Row, b: Row) =>
  Number(b.asks.length > 0) - Number(a.asks.length > 0) || b.at - a.at
