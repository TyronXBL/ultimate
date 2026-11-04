/**
 * Conversations for other extensions' browser code: references to conversations with their features, agent marks,
 * the primary agent, which conversations a conclusion hides, the overview document and the conversation actions, and
 * the points where optional extensions describe a conversation (its working phase, its plan task).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { definePoint, useTasks, useUiState } from '@/sdk'
import { activityOf } from '../../lib/activity.ts'
import type { Activity } from '../../lib/activity.ts'
import { concludedIds, concludedKeys, concludedOf } from '../../lib/concluded.ts'
import { useOverview } from './feature.tsx'

/**
 * What a working conversation `id` is doing (`phase` provides it): `label` for a row's activity line, `word` in lower
 * case in place of "working", and whether it only `waiting` on its subagents. Undefined while not known.
 */
export const ConversationPhase = definePoint<
  number | undefined,
  { label: ReactNode; word: string; waiting: boolean } | undefined
>('conversations.phase')
/** What top-level conversation `id` and its subagents cost (`status-line` provides it): a chip, or nothing. */
export const ConversationSpend = definePoint<number, ReactNode>('conversations.spend')
/** Whether conversation `id` gets no summaries, so its transcript hides older summary lines (lineage: a root). */
export const Unsummarized = definePoint<number, boolean>('conversations.unsummarized')
/** The plan task conversation `id` works on (`plan` provides it): its chip and title. */
export const ConversationTask = definePoint<
  number | undefined,
  { chip: ReactNode; title: string } | undefined
>('conversations.task')
/**
 * The epic coordinator `id` works itself (`plan` provides it): its newest open epic, else its newest, when none of its
 * tasks went to a subagent; `open` shows it in the plan panel.
 */
export const ConversationEpic = definePoint<
  number,
  { key: string; title: string; status: string; open: () => void } | undefined
>('conversations.epic')

export { ConversationRef, FeatureTag, useOverview, useStandingName } from './feature.tsx'

/**
 * Each conversation's activity (`lib/activity.ts`), as every view says it: its foreground tasks from the live task
 * graph (the conversation list's `busy` can lag it), its run and queued input from the overview, and `parked`, the runs
 * a pause holds (the `ParkedRuns` point).
 */
export function useActivity(parked?: ReadonlySet<number>): (id: number) => Activity {
  const overview = useOverview()
  const tasks = useTasks()
  const foreground = useMemo(
    () =>
      new Set<number>(
        Object.values(tasks?.tasks ?? {})
          .filter((task) => !task.background)
          .map((task) => task.conversationId),
      ),
    [tasks],
  )
  return (id) =>
    activityOf({
      task: foreground.has(id),
      run: overview[id]?.runState === 'working',
      queued: overview[id]?.runState === 'queued',
      parked: parked?.has(id),
    })
}
export { AgentMark, agentTitle } from './marks.tsx'
export type { Presence } from './marks.tsx'
export { hiddenConversationIds } from './visible.tsx'

function useConcludedState() {
  const [ids] = useUiState<number[]>(concludedKeys.ids, [])
  const [at] = useUiState<Record<string, number>>(concludedKeys.at, {})
  return { [concludedKeys.ids]: ids, [concludedKeys.at]: at }
}

/** The concluded conversations' ids. */
export function useConcludedIds(): number[] {
  return concludedIds(useConcludedState())
}

/**
 * Since when each conversation counts as concluded: forever while it is, else when it was last concluded (kept when
 * it is resumed); undefined for one never concluded. What it said before then is settled.
 */
export function useConcludedSince(): (id: number) => number | undefined {
  const ui = useConcludedState()
  return (id) => {
    const concluded = concludedOf(ui, id)
    return concluded.state === 'concluded'
      ? Infinity
      : concluded.state === 'resumed'
        ? concluded.at
        : undefined
  }
}
export {
  Compacted,
  ConcludeAction,
  ContextDoc,
  OverviewDoc,
  RenameAction,
  ResumeAction,
  SummariesAction,
} from './refs.ts'
