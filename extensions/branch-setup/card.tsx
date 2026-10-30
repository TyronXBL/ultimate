import type { EntryRecord } from '@earendil-works/pi-durable'
import { GitBranchIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Fold, useDoc } from '@/sdk'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BranchSetupDoc } from '../subagents/ui.tsx'
import type { SetupEntry } from './refs.ts'
import { decode, modelId } from './state.tsx'
import type { Pick } from './state.tsx'

/** Agent → model · thinking, one line each, the agents in the order they were given. */
function AgentList({ agents }: { agents: readonly (readonly [string, Pick])[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {agents.map(([name, pick]) => (
        <div className="contents" key={name}>
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="min-w-0 truncate text-foreground/85" title={pick.model}>
            {modelId(pick.model)}
            {pick.thinking && <span className="text-muted-foreground"> · {pick.thinking}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The user's request with the agent setup its branch starts on, in @ultimate's transcript: on the user's side, like
 * their typed messages, with the agents they changed under it.
 */
export function SetupCard({ entry }: { entry: EntryRecord }) {
  const { text, agents } = entry.data as SetupEntry
  const picks = Object.entries(agents).map(([name, value]) => [name, decode(value)] as const)
  const head = (
    <>
      <GitBranchIcon className="size-3 shrink-0 text-brand" />
      <span className="min-w-0 truncate">
        New branch · {picks.length} {picks.length === 1 ? 'agent' : 'agents'} changed
      </span>
    </>
  )
  return (
    <div className="mt-3 flex justify-end first:mt-0">
      <Fold card={entry.id} keep summary={head}>
        <section
          className="w-full max-w-md min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40"
          data-branch-setup-card
        >
          <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            {head}
          </header>
          <p className="px-3 py-2 text-[13.5px] leading-snug break-words whitespace-pre-wrap">
            {text}
          </p>
          {picks.length > 0 && (
            <div className="border-t border-border/50 px-3 py-2">
              <AgentList agents={picks} />
            </div>
          )}
        </section>
      </Fold>
    </div>
  )
}

/** In a branch's header: a quiet chip when it runs on its own agent setup, listing it on click. */
export function SetupChip() {
  const agents = useDoc(BranchSetupDoc)?.agents
  if (!agents || Object.keys(agents).length === 0) return null
  const picks = Object.entries(agents).map(
    ([name, ref]) =>
      [name, { model: `${ref.provider}/${ref.modelId}`, thinking: ref.thinking }] as const,
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
          data-branch-setup-chip
          title="This branch runs its own agent setup"
          type="button"
        >
          <SlidersHorizontalIcon className="size-3 text-brand" />
          custom setup
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <header className="border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <span className="text-foreground">Custom setup</span> · this branch and its subagents
        </header>
        <div className="px-3 py-2">
          <AgentList agents={picks} />
        </div>
        <p className="border-t border-border/60 px-3 py-1.5 font-mono text-[10.5px] text-muted-foreground/70">
          Others run as defined.
        </p>
      </PopoverContent>
    </Popover>
  )
}
