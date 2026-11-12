/**
 * What a branch and each of its agents cost: a quiet chip for the tree and a figure for each agent, each with a card on
 * hover (or a tap) that breaks it down by agent, token kind and model.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  api,
  cn,
  formatTokens,
  useConversation,
  useConversations,
  useConversationSummary,
  useNow,
  useUltimate,
  useViewport,
} from '@/sdk'
import { add, empty } from './context.ts'
import { TreesAction } from './refs.ts'
import type { AgentSpend, Spend, TreeSpend } from './refs.ts'

let trees: Record<string, TreeSpend> | undefined
/** Each conversation's tree top in `trees`, worked out on first use after a read. */
let tops: Map<number, string> | undefined
let readAt = 0
let reading = false
let again = false
/** The running conversations the last read was asked for, shared by every chip. */
let seen: string | undefined
const listeners = new Set<() => void>()

/**
 * Read every tree's spend, one read for every chip. A call during a read reads once more after it, so a run that ends
 * while a read is under way is never left out.
 */
function read() {
  if (reading) {
    again = true
    return
  }
  reading = true
  api
    .action(TreesAction)
    .then((next) => {
      // Null while the server is still reading every conversation's usage.
      if (!next) again = true
      else {
        trees = next
        tops = undefined
        for (const listener of listeners) listener()
      }
    })
    // The last numbers stay; the next run start or end reads again.
    .catch((error: unknown) => console.warn('Spend', error))
    .finally(() => {
      reading = false
      readAt = Date.now()
      if (!again) return
      again = false
      setTimeout(read, trees ? 0 : 2000)
    })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const topOf = (id: number) => {
  if (!trees) return undefined
  if (!tops) {
    tops = new Map()
    for (const [top, tree] of Object.entries(trees))
      for (const agent of Object.keys(tree.agents)) tops.set(Number(agent), top)
  }
  return tops.get(id)
}

/**
 * Every tree's spend, read again when any conversation starts or ends a run, and every 15 seconds while one runs,
 * since every model call of a run adds to it.
 */
function useTrees() {
  const running = useConversations()
    .filter((conversation) => conversation.busy)
    .map((conversation) => conversation.id)
    .join(',')
  const now = useNow(15_000, running !== '')
  useEffect(() => {
    if (running === seen && trees) return
    seen = running
    read()
  }, [running])
  useEffect(() => {
    if (Date.now() - readAt >= 10_000) read()
  }, [now])
  return useSyncExternalStore(subscribe, () => trees)
}

const tokensOf = (spend: Spend) => spend.input + spend.output + spend.cacheRead + spend.cacheWrite
const dollars = (cost: number) =>
  cost < 0.005 ? '<$0.01' : `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}`
/** Dollars, or tokens where no model of it has a price. */
const amount = (spend: Spend) =>
  spend.cost > 0 ? dollars(spend.cost) : `${formatTokens(tokensOf(spend))} tok`
const order = (a: Spend, b: Spend) => b.cost - a.cost || tokensOf(b) - tokensOf(a)

/** The spend of `models` added up. */
function sum(models: Record<string, Spend>) {
  const total = empty()
  for (const spend of Object.values(models)) add(total, spend)
  return total
}

/** The models (`provider/model`) of `models` grouped by provider (`tools` for tools), the costliest first. */
function byProvider(models: Record<string, Spend>) {
  const groups = new Map<string, { total: Spend; models: [string, Spend][] }>()
  for (const [key, spend] of Object.entries(models)) {
    const slash = key.indexOf('/')
    const provider = key.slice(0, slash)
    const group = groups.get(provider) ?? { total: empty(), models: [] }
    add(group.total, spend)
    group.models.push([key.slice(slash + 1), spend])
    groups.set(provider, group)
  }
  for (const group of groups.values()) group.models.sort(([, a], [, b]) => order(a, b))
  return [...groups].toSorted(([, a], [, b]) => order(a.total, b.total))
}

/** A tree's models added up over its agents. */
function treeModels(tree: TreeSpend) {
  const models: Record<string, Spend> = {}
  for (const agent of Object.values(tree.agents))
    for (const [key, spend] of Object.entries(agent.models)) add((models[key] ??= empty()), spend)
  return models
}

/** A tree's agents from its top down, each after its owner, in the order they started, with their depth. */
function walk(tree: TreeSpend, top: string) {
  const children = new Map<string, string[]>()
  for (const [id, agent] of Object.entries(tree.agents))
    if (agent.owner !== undefined) {
      const owner = String(agent.owner)
      children.set(owner, [...(children.get(owner) ?? []), id])
    }
  const rows: { id: number; agent: AgentSpend; depth: number }[] = []
  const visit = (id: string, depth: number) => {
    const agent = tree.agents[id]
    if (agent) rows.push({ id: Number(id), agent, depth })
    for (const child of (children.get(id) ?? []).toSorted((a, b) => Number(a) - Number(b)))
      visit(child, depth + 1)
  }
  visit(top, 0)
  return rows
}

/** The model an agent spent most on, without its provider, and how many others it used; tools do not count. */
function mainModel(agent: AgentSpend) {
  const models = Object.entries(agent.models)
    .filter(([key]) => !key.startsWith('tools/'))
    .toSorted(([, a], [, b]) => order(a, b))
  const [key] = models[0] ?? []
  if (!key) return undefined
  const slash = key.indexOf('/')
  return { provider: key.slice(0, slash), model: key.slice(slash + 1), others: models.length - 1 }
}

/** How a person knows conversation `id`: a standing agent by its `@name`, else its label. */
function useAgentName(id: number) {
  const summary = useConversationSummary(id)
  return summary?.label === 'agent' ? summary.title : (summary?.label ?? 'conversation')
}

/** A spend's dollars, or `no price` where its models have none. */
function Price({ spend, strong }: { spend: Spend; strong?: boolean }) {
  return (
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
  )
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
      <Price spend={spend} strong={strong} />
    </>
  )
}

const grid = 'grid grid-cols-[minmax(0,1fr)_auto_4.5rem] gap-x-3 px-3 py-2'
const heading = 'col-span-3 pb-0.5 text-[10.5px] text-muted-foreground/80'

/** Tokens and dollars by provider and model. */
function Models({ models }: { models: Record<string, Spend> }) {
  return (
    <div className={cn(grid, 'border-t border-border/70')}>
      <span className={heading}>By model</span>
      {byProvider(models).map(([provider, group]) => (
        <div className="contents" key={provider}>
          <Line label={provider} spend={group.total} strong />
          {group.models.map(([model, spend]) => (
            <Line key={model} label={model} spend={spend} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Tokens by kind, as the composer's status line writes them. */
function Kinds({ spend }: { spend: Spend }) {
  return (
    <span className="text-muted-foreground tabular-nums">
      ↑{formatTokens(spend.input)} ↓{formatTokens(spend.output)} R{formatTokens(spend.cacheRead)} W
      {formatTokens(spend.cacheWrite)}
    </span>
  )
}

const footnote = 'border-t border-border/70 px-3 py-1.5 text-[10.5px] text-muted-foreground/80'
const card = 'max-w-[calc(100vw-1rem)] p-0 font-mono text-[11.5px] leading-[1.5]'

/** Opens conversation `id` on the Agent surface. */
function useOpen() {
  const actions = useUltimate()
  return (id: number) => {
    actions.showSurface('agent')
    actions.switchConversation(id)
  }
}

/** One agent of a branch's card: its name and `#id` indented under its owner, its main model, tokens and dollars. */
function AgentLine({
  id,
  agent,
  depth,
  onOpen,
}: {
  id: number
  agent: AgentSpend
  depth: number
  onOpen: (id: number) => void
}) {
  const name = useAgentName(id)
  const spend = sum(agent.models)
  const model = mainModel(agent)
  return (
    <button
      className="col-span-3 -mx-1.5 grid cursor-pointer grid-cols-subgrid rounded px-1.5 text-left outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
      data-spend-agent={id}
      onClick={() => onOpen(id)}
      title={`Open #${id}`}
      type="button"
    >
      <span className="flex min-w-0 gap-1.5" style={{ paddingLeft: Math.max(0, depth - 1) * 12 }}>
        {depth > 0 && <span className="shrink-0 text-muted-foreground/40">└</span>}
        <span className="shrink-0 text-foreground">{name}</span>
        <span className="shrink-0 text-muted-foreground/60">#{id}</span>
        {model && (
          <span className="truncate text-muted-foreground">
            {model.model}
            {model.others > 0 && ` +${model.others}`}
          </span>
        )}
      </span>
      <span className="text-right text-muted-foreground tabular-nums">
        {tokensOf(spend) > 0 ? formatTokens(tokensOf(spend)) : '—'}
      </span>
      {tokensOf(spend) > 0 ? <Price spend={spend} /> : <span />}
    </button>
  )
}

/** Conversation `id`'s chip, a hook: undefined until its tree has spent anything. */
export function useSpendChip(id: number, className?: string) {
  const tree = useTrees()?.[String(id)]
  return tree && <SpendChip className={className} id={id} tree={tree} />
}

/**
 * The chip: the tree's dollars at API prices. Hovering it a moment, or tapping it, opens its card: the tree's tokens
 * by kind, each agent with its own spend, and the models.
 */
function SpendChip({ id, tree, className }: { id: number; tree: TreeSpend; className?: string }) {
  const [open, setOpen] = useState(false)
  const show = useOpen()
  const models = treeModels(tree)
  const total = sum(models)
  const agents = walk(tree, String(id))
  return (
    <HoverCard closeDelay={150} onOpenChange={setOpen} open={open} openDelay={300}>
      <HoverCardTrigger asChild>
        <button
          aria-label={`What #${id} cost`}
          className={cn(
            'shrink-0 cursor-pointer touch-target tabular-nums hover:text-foreground hover:underline data-[state=open]:text-foreground',
            className,
          )}
          data-spend={id}
          // A tap opens it where nothing hovers; the row around it must not open the conversation.
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
          type="button"
        >
          {amount(total)}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className={cn(card, 'w-[26rem]')} collisionPadding={8}>
        <header className="flex flex-wrap items-baseline gap-x-2 border-b border-border/70 px-3 py-2">
          <span className="font-medium text-foreground">#{id}</span>
          <span className="text-muted-foreground">
            {agents.length === 1 ? '1 agent' : `${agents.length} agents`}
          </span>
          <span className="ml-auto text-foreground tabular-nums">{amount(total)}</span>
          <span className="basis-full">
            <Kinds spend={total} />
          </span>
        </header>
        <div className={grid}>
          <span className={heading}>By agent</span>
          {agents.map((row) => (
            <AgentLine
              key={row.id}
              {...row}
              onOpen={(agent) => {
                setOpen(false)
                show(agent)
              }}
            />
          ))}
        </div>
        <Models models={models} />
        <p className={footnote}>
          Tokens and their price at each model’s API rates. A subscription counts against its limits
          instead. Previews are not counted.
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}

const kinds = [
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache read'],
  ['cacheWrite', 'cache write'],
] as const

/**
 * Conversation `id`'s own spend, a hook: a quiet figure for its row and the body of its hover card, its tokens and
 * dollars by kind and model and what its subagents add; undefined until it has spent anything.
 */
export function useAgentSpend(id: number | undefined) {
  const all = useTrees()
  const top = id === undefined ? undefined : topOf(id)
  const tree = top === undefined ? undefined : all?.[top]
  const agent = tree?.agents[String(id)]
  if (id === undefined || !tree || !agent || !Object.keys(agent.models).length) return undefined
  const spend = sum(agent.models)
  const below = walk(tree, String(id)).slice(1)
  const share = empty()
  for (const row of below) add(share, sum(row.agent.models))
  return {
    figure: (
      <span
        className="shrink-0 font-mono text-muted-foreground/80 tabular-nums"
        data-agent-spend={id}
      >
        {amount(spend)}
      </span>
    ),
    card: <AgentCard agent={agent} below={below.length} share={share} spend={spend} />,
  }
}

/** One agent's own spend: by token kind with each kind's dollars, then by model, then what its subagents add. */
function AgentCard({
  agent,
  spend,
  below,
  share,
}: {
  agent: AgentSpend
  spend: Spend
  below: number
  share: Spend
}) {
  const model = mainModel(agent)
  return (
    <div className={cn(card, 'w-full')} data-agent-card>
      <header className="flex items-baseline gap-2 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 truncate text-foreground">
          {model ? model.model : 'tools'}
          {model && <span className="text-muted-foreground"> · {model.provider}</span>}
          {model && model.others > 0 && (
            <span className="text-muted-foreground"> +{model.others}</span>
          )}
        </span>
        <span className="ml-auto shrink-0 text-foreground tabular-nums">{amount(spend)}</span>
      </header>
      <div className={grid}>
        {kinds.map(([kind, label]) => (
          <div className="contents" key={kind}>
            <span className="text-foreground/80">{label}</span>
            <span className="text-right text-muted-foreground tabular-nums">
              {formatTokens(spend[kind])}
            </span>
            <span
              className={cn(
                'text-right tabular-nums',
                spend.costs[kind] > 0 ? 'text-foreground/80' : 'text-muted-foreground/70',
              )}
            >
              {spend[kind] === 0
                ? '—'
                : spend.costs[kind] > 0
                  ? dollars(spend.costs[kind])
                  : 'no price'}
            </span>
          </div>
        ))}
      </div>
      {Object.keys(agent.models).length > 1 && <Models models={agent.models} />}
      <p className={footnote}>
        Its own model calls at API prices
        {below === 0
          ? '.'
          : tokensOf(share) === 0
            ? `; ${below === 1 ? 'its subagent has' : `its ${below} subagents have`} spent nothing yet.`
            : `; ${below === 1 ? 'its subagent adds' : `its ${below} subagents add`} ${amount(share)}.`}
      </p>
    </div>
  )
}

/**
 * The shown conversation's tree spend in the Agent surface's header, on a desktop; a phone's header has no room, and
 * another surface's header is not about the conversation.
 */
export function HeaderSpend() {
  const id = useConversation((conversation) => conversation.id)
  const { surface } = useUltimate()
  const phone = useViewport() === 'phone'
  return surface === 'agent' && !phone && id !== undefined ? <HeaderChip id={id} /> : null
}

function HeaderChip({ id }: { id: number }) {
  return (
    useSpendChip(
      id,
      'rounded px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:no-underline',
    ) ?? null
  )
}
