/**
 * Subagents for other extensions' browser code: opening the message that started an agent, the standing agents and
 * talking to the primary one, and the agent definitions.
 */
import { WandSparklesIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, events, useDocOf } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { RunsDoc, StandingAction } from './refs.ts'
import type { Run } from './refs.ts'
import { BackupsDoc } from '../models/ui.tsx'
import type { BackupShown } from '../models/ui.tsx'
import { familyTitle } from '../../lib/families.ts'

export {
  BranchSetupDoc,
  DefinitionAction,
  DefinitionsAction,
  StandingAction,
  StandingDoc,
} from './refs.ts'

/** What child `id` was started on, its model id and whether it was made on the fly; undefined for other conversations. */
export function useRun(id: number | undefined): Run | undefined {
  const runs = useDocOf(1, RunsDoc)
  return id === undefined ? undefined : runs?.[String(id)]
}

/**
 * Why a child runs on another model than its definition gives it: a few words for its row (`coordinator's choice`,
 * `branch setup`, `backup (rate limit)`) and the whole story for the tooltip. Undefined when it runs on its own.
 */
function runReason(run: Run | undefined, backup: BackupShown | undefined, name: string) {
  const override = run?.override
  if (!override && !backup) return undefined
  const own =
    override &&
    `${name}'s definition runs on ${override.family ? `${familyTitle(override.family)}: ` : ''}${override.own}.`
  const chosen =
    override &&
    (override.by === 'setup'
      ? `This branch's agent setup runs it on ${run.model} instead.`
      : `${override.caller ?? 'Its caller'} started it with ${override.asked}, so it ran on ${run.model}.`)
  return {
    word: backup
      ? `backup (${backup.reason})`
      : override!.by === 'setup'
        ? 'branch setup'
        : `${override!.caller ?? 'caller'}'s choice`,
    detail: [
      own,
      chosen,
      backup &&
        `${backup.from} answered with a ${backup.reason} error, so it runs on the backup ${backup.model} for now.`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

/**
 * A child's name as rows and cards show it: its label, then the model it runs on, muted, and a wand when `subagent
 * start` made it on the fly rather than from a definition. When that model is not its definition's, a card says why
 * after it (truncated first) and a `compact` sidebar row underlines the model, dotted; both tell the whole story on hover.
 */
export function RunName({
  id,
  label,
  compact,
}: {
  id: number | undefined
  label: ReactNode
  compact?: boolean
}) {
  const run = useRun(id)
  const backups = useDocOf(1, BackupsDoc)
  // Only a child `subagent start` made has a row that says what it runs on.
  const backup = run && id !== undefined ? backups?.[String(id)] : undefined
  const reason = runReason(run, backup, typeof label === 'string' ? label : 'This agent')
  const model = backup?.model ?? run?.model
  const name = (
    <>
      {run?.adhoc && (
        <WandSparklesIcon
          aria-label="Made on the fly"
          className="mr-1 inline size-3 shrink-0 align-[-2px] text-muted-foreground"
        >
          <title>Made on the fly, without a definition</title>
        </WandSparklesIcon>
      )}
      {label}
      {model && (
        <span className="text-muted-foreground/70">
          {' · '}
          {compact && reason ? (
            <span
              className="underline decoration-dotted underline-offset-2"
              data-run-reason
              title={`${reason.word}\n${reason.detail}`}
            >
              {model}
            </span>
          ) : (
            model
          )}
        </span>
      )}
    </>
  )
  if (compact || !reason) return name
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline overflow-hidden">
      <span className="max-w-full shrink-0 truncate">{name}</span>
      <span
        className="min-w-0 shrink-[1000] truncate text-muted-foreground/60"
        data-run-reason
        title={reason.detail}
      >
        {'\u00a0· '}
        {reason.word}
      </span>
    </span>
  )
}

/** Show the primary agent's standing conversation on the Agent surface: @ultimate starts branches and keeps tallies. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const id = await api.action(StandingAction, { name: 'ultimate' })
  actions.switchConversation(id)
  actions.showSurface('agent')
}

/** Show `source`, where an agent's message came from, with a way back to `receiver`, where it arrived. */
export function openAgentSource(
  switchConversation: (id: number) => void,
  source: { conversation: number; entry?: number },
  receiver: { conversation: number; entry?: number },
) {
  events.emit('subagents:source', { target: source, back: receiver })
  switchConversation(source.conversation)
}
