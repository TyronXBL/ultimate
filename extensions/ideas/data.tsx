/** The board's rows: each idea with its stage, its branch and the decisions it waits on, all read live. */
import { useCallback, useEffect, useState } from 'react'
import { useDocOf, useExtensionUiState } from '@/sdk'
import type { BranchLanding } from '../../lib/standing.ts'
import { MessagesDoc, emptyMessages } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { PlanDoc } from '../plan/ui.tsx'
import { waiting } from '../questions/ui.tsx'
import { useFlightWork, useStandings } from '../sidebar/ui.tsx'
import { useWorkspaceConversations } from '../workspaces/ui.tsx'
import type { WorkspaceConversation } from '../workspaces/ui.tsx'
import type { Standing } from '../../lib/standing.ts'
import { IdeasDoc } from './refs.ts'
import type { Idea } from './refs.ts'
import { stageOf } from './stage.ts'
import type { Column } from './stage.ts'

export type Row = {
  idea: Idea
  column: Column
  note?: 'launching' | 'not built'
  /** Its linked branch, once @ultimate started it and while it is known. */
  branch?: WorkspaceConversation
  /** Where its branch stands, once linked. */
  standing?: Standing
  /** What its branch landed since its latest input. */
  landed?: BranchLanding
  /** Messages from or about its branch that wait on the user, oldest first. */
  asks: Message[]
  /** When it last moved: the branch's latest input or answer, else when it was parked, launched or added. */
  at: number
}

/** Reports whether `branch` has a plan epic, or undefined while its plan has not streamed in. */
function PlanProbe({
  branch,
  onPlan,
}: {
  branch: number
  onPlan: (branch: number, planned: boolean | undefined) => void
}) {
  const plan = useDocOf(branch, PlanDoc)
  const planned = plan ? Object.keys(plan.epics).length > 0 : undefined
  useEffect(() => onPlan(branch, planned), [branch, planned, onPlan])
  return null
}

/** Every idea as a row of the board, and the probes that must be mounted for them to know about plans. */
export function useBoard(parked?: ReadonlySet<number>) {
  const items = useDocOf(1, IdeasDoc)?.items
  const conversations = useWorkspaceConversations()
  const standingOf = useStandings(conversations, parked)
  const asks = waiting((useDocOf(1, MessagesDoc) ?? emptyMessages).messages).toReversed()
  // Each watched branch's plan: whether it has an epic, absent while its plan has not streamed in.
  const [planned, setPlanned] = useState<Record<number, boolean>>({})
  const onPlan = useCallback(
    (branch: number, value: boolean | undefined) =>
      setPlanned((before) => {
        if (before[branch] === value) return before
        const next = { ...before }
        if (value === undefined) delete next[branch]
        else next[branch] = value
        return next
      }),
    [],
  )
  // A first-paint hint only: branches last seen building, read while their own facts are still streaming in.
  const [seen, setSeen] = useExtensionUiState<number[]>('started', [])
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  const linked = (items ?? []).flatMap((idea) => {
    const branch = idea.launch?.branch === undefined ? undefined : byId.get(idea.launch.branch)
    return branch ? [branch] : []
  })
  const work = useFlightWork(linked)
  const rows = (items ?? []).map((idea): Row => {
    const id = idea.launch?.branch
    const branch = id === undefined ? undefined : byId.get(id)
    const standing = id === undefined ? undefined : standingOf(branch ?? { id })
    // Building, from facts that last: a plan epic, unlanded commits, or any landing of it.
    const started =
      id !== undefined &&
      (planned[id] ||
        !!work.get(id)?.commits ||
        standing?.landing !== undefined ||
        (planned[id] === undefined && seen.includes(id)))
    const activity = branch ? Math.max(branch.inputAt ?? 0, branch.answerAt ?? 0) : 0
    return {
      idea,
      ...stageOf(idea, standing && { standing: standing.state, started }),
      branch,
      ...(standing ? { standing: standing.state } : {}),
      ...(standing?.state === 'landed' || standing?.state === 'waits'
        ? { landed: standing.landing }
        : {}),
      asks:
        id === undefined
          ? []
          : asks.filter((message) => message.about === id || message.from === id),
      at: Math.max(activity, idea.parked ?? 0, idea.launch?.at ?? 0, idea.at),
    }
  })
  const building = rows.flatMap((row) =>
    row.column === 'building' && row.branch ? [row.branch.id] : [],
  )
  const hint = building.filter((id) => !seen.includes(id))
  useEffect(() => {
    if (hint.length) setSeen([...seen, ...hint])
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `hint` names what changed; `seen` is read when it does
  }, [hint.join(',')])
  // Plans are watched only where they decide something: an assessment not yet known to be building.
  const probes = rows.flatMap((row) =>
    row.branch &&
    row.idea.launch?.size === 'assess' &&
    (row.column === 'assessing' || row.column === 'building')
      ? [<PlanProbe branch={row.branch.id} key={row.branch.id} onPlan={onPlan} />]
      : [],
  )
  return { loading: items === undefined, rows, probes }
}

const needsYou = (a: Row, b: Row) => Number(b.asks.length > 0) - Number(a.asks.length > 0)
const recent = (a: Row, b: Row) => b.at - a.at

/** The board's order within a stage: what needs you first, then what moved last. */
export const byUrgency = (a: Row, b: Row) => needsYou(a, b) || recent(a, b)

/** The order of one list across stages: what needs you first, then by stage in `order`, then what moved last. */
export const byUrgencyAcross = (order: readonly Column[]) => (a: Row, b: Row) =>
  needsYou(a, b) || order.indexOf(a.column) - order.indexOf(b.column) || recent(a, b)
