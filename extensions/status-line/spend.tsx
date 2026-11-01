/** What a branch cost: its tree's spend as a quiet chip, with a popover by provider and model. */
import { useEffect, useSyncExternalStore } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  formatTokens,
  useConversation,
  useConversations,
  useNow,
  useUltimate,
} from '@/sdk'
import { TreesAction } from './refs.ts'
import type { Spend, TreeSpend } from './refs.ts'

let trees: Record<string, TreeSpend> | undefined
let readAt = 0
let reading = false
const listeners = new Set<() => void>()

/** Read every tree's spend again unless a read is under way or one finished within `fresh` ms; one for every chip. */
function read(fresh: number) {
  if (reading || Date.now() - readAt < fresh) return
  reading = true
  api
    .action(TreesAction)
    .then((next) => {
      if (!next) return
      trees = next
      for (const listener of listeners) listener()
    })
    // The last numbers stay; the next run start or end reads again.
    .catch((error: unknown) => console.warn('Spend', error))
    .finally(() => {
      reading = false
      readAt = Date.now()
    })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Conversation `id`'s tree spend, read again when any conversation starts or ends a run, and every 15 seconds while
 * one runs, since every model call of a run adds to it.
 */
function useTreeSpend(id: number | undefined) {
  const running = useConversations()
    .filter((conversation) => conversation.busy)
    .map((conversation) => conversation.id)
    .join(',')
  const now = useNow(15_000, running !== '')
  useEffect(() => read(1000), [running])
  useEffect(() => read(10_000), [now])
  const all = useSyncExternalStore(subscribe, () => trees)
  return id === undefined ? undefined : all?.[String(id)]
}

const tokensOf = (spend: Spend) => spend.input + spend.output + spend.cacheRead + spend.cacheWrite
const dollars = (cost: number) => `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`
/** Dollars, or tokens where no model of it has a price. */
const amount = (spend: Spend) =>
  spend.cost > 0 ? dollars(spend.cost) : `${formatTokens(tokensOf(spend))} tok`

function add(sum: Spend, spend: Spend) {
  sum.input += spend.input
  sum.output += spend.output
  sum.cacheRead += spend.cacheRead
  sum.cacheWrite += spend.cacheWrite
  sum.cost += spend.cost
}
const empty = (): Spend => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })

/** The tree's models grouped by provider (`tools` for tools), the costliest first. */
function byProvider(tree: TreeSpend) {
  const groups = new Map<string, { total: Spend; models: [string, Spend][] }>()
  for (const [key, spend] of Object.entries(tree.models)) {
    const slash = key.indexOf('/')
    const provider = key.slice(0, slash)
    const group = groups.get(provider) ?? { total: empty(), models: [] }
    add(group.total, spend)
    group.models.push([key.slice(slash + 1), spend])
    groups.set(provider, group)
  }
  const order = (a: Spend, b: Spend) => b.cost - a.cost || tokensOf(b) - tokensOf(a)
  for (const group of groups.values()) group.models.sort(([, a], [, b]) => order(a, b))
  return [...groups].toSorted(([, a], [, b]) => order(a.total, b.total))
}

function Line({ label, spend, strong }: { label: string; spend: Spend; strong?: boolean }) {
  return (
    <>
      <span className={cn('truncate', strong ? 'text-foreground' : 'pl-3 text-foreground/80')}>
        {label}
      </span>
      <span className="text-right text-muted-foreground tabular-nums">
        {formatTokens(tokensOf(spend))}
      </span>
      <span
        className={cn(
          'text-right tabular-nums',
          spend.cost > 0
            ? strong
              ? 'text-foreground'
              : 'text-foreground/80'
            : 'text-muted-foreground/70',
        )}
      >
        {spend.cost > 0 ? dollars(spend.cost) : 'no price'}
      </span>
    </>
  )
}

/** Conversation `id`'s chip, a hook: undefined until its tree has spent anything. */
export function useSpendChip(id: number | undefined, className?: string) {
  const tree = useTreeSpend(id)
  return id !== undefined && tree && <SpendChip className={className} id={id} tree={tree} />
}

/** The chip: the tree's dollars at API prices, opening its breakdown. */
function SpendChip({ id, tree, className }: { id: number; tree: TreeSpend; className?: string }) {
  const total = empty()
  for (const spend of Object.values(tree.models)) add(total, spend)
  const others = tree.conversations - 1
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={`What #${id} cost`}
          className={cn(
            'shrink-0 cursor-pointer touch-target tabular-nums hover:text-foreground hover:underline data-[state=open]:text-foreground',
            className,
          )}
          data-spend={id}
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          {amount(total)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[22rem] max-w-[calc(100vw-1rem)] p-0 font-mono text-[11.5px] leading-[1.5]"
      >
        <header className="flex items-baseline gap-2 border-b border-border/70 px-3 py-2">
          <span className="font-medium text-foreground">#{id}</span>
          <span className="text-muted-foreground">
            {others > 0
              ? `with ${others} ${others === 1 ? 'subagent' : 'subagents'}`
              : 'no subagents'}
          </span>
          <span className="ml-auto text-foreground tabular-nums">{amount(total)}</span>
        </header>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] gap-x-3 px-3 py-2">
          {byProvider(tree).map(([provider, group]) => (
            <div className="contents" key={provider}>
              <Line label={provider} spend={group.total} strong />
              {group.models.map(([model, spend]) => (
                <Line key={model} label={model} spend={spend} />
              ))}
            </div>
          ))}
        </div>
        <p className="border-t border-border/70 px-3 py-1.5 text-[10.5px] text-muted-foreground/80">
          Tokens and their price at each model’s API rates, subagents included. A subscription
          counts against its limits instead. Previews are not counted.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The shown conversation's tree spend in the Agent surface's header, on a desktop; a phone's header has no room, and
 * another surface's header is not about the conversation.
 */
export function HeaderSpend() {
  const id = useConversation((conversation) => conversation.id)
  const agent = useUltimate().surface === 'agent'
  return (
    useSpendChip(
      agent ? id : undefined,
      'rounded px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:no-underline max-md:hidden',
    ) ?? null
  )
}
