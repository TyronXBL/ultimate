import { ChevronRightIcon, LightbulbIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  cn,
  Conversation,
  ConversationScope,
  Dock,
  errorMessage,
  Header,
  StatusLine,
  useDocOf,
  useNow,
  useViewport,
} from '@/sdk'
import { StandingDoc } from '../subagents/ui.tsx'
import { IdeaCard } from './card.tsx'
import { byUrgency, byUrgencyAcross, useBoard } from './data.tsx'
import type { Row } from './data.tsx'
import { IdeaForm } from './form.tsx'
import type { Fields } from './form.tsx'
import { AddAction } from './refs.ts'
import { columns } from './stage.ts'
import type { Column } from './stage.ts'

/** What each empty column is for, so a new board explains its own flow. */
const empty: Record<Column, string> = {
  ideas: '',
  assessing: 'Launched ideas are weighed here first.',
  building: 'Branches at work.',
  landed: 'Work that reached the target.',
  parked: '',
}

/** Adds an idea, keeping the server's refusal on the form. */
function AddIdea({ className }: { className?: string }) {
  const [error, setError] = useState<string>()
  const add = (fields: Fields) => {
    setError(undefined)
    return api.action(AddAction, { ...fields, notes: fields.notes || undefined }).then(
      () => true,
      (cause: unknown) => {
        setError(errorMessage(cause))
        return false
      },
    )
  }
  return <IdeaForm className={className} error={error} onSave={add} />
}

/**
 * The Board surface: the project's ideas from collected to landed. On a desktop its columns sit beside @ultimate's own
 * conversation, docked; on a phone it is one list, what needs you first, each card with its stage.
 */
export function Board() {
  const phone = useViewport() === 'phone'
  const { rows, probes, loading } = useBoard()
  const needs = rows.filter((row) => row.asks.length > 0).length
  return (
    <>
      {!phone && (
        <Header>
          <span className="flex min-w-0 items-baseline gap-2 pl-1">
            <span className="text-[13px] font-medium">Board</span>
            <span
              className={cn(
                'truncate font-mono text-[11px] text-muted-foreground',
                loading && 'invisible',
              )}
            >
              {rows.filter((row) => row.column !== 'parked').length} ideas
              {needs > 0 && <span className="text-warning"> · {needs} need you</span>}
            </span>
          </span>
        </Header>
      )}
      {probes}
      {phone ? (
        <PhoneList loading={loading} rows={rows} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Columns loading={loading} rows={rows} />
          <UltimateDock />
        </div>
      )}
      <StatusLine />
    </>
  )
}

/** @ultimate's conversation beside the board, whatever conversation the Agent surface shows. */
function UltimateDock() {
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  if (ultimate === undefined) return null
  return (
    <ConversationScope id={ultimate}>
      <Dock title="@ultimate">
        <Conversation variant="dock" />
      </Dock>
    </ConversationScope>
  )
}

function ColumnHead({ label, rows, loading }: { label: string; rows: Row[]; loading: boolean }) {
  const needs = rows.filter((row) => row.asks.length > 0).length
  return (
    <h2 className="flex items-baseline gap-1.5 px-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {label}
      {!loading && <span className="tracking-normal text-muted-foreground/60">{rows.length}</span>}
      {needs > 0 && (
        <span className="ml-auto tracking-normal normal-case text-warning">{needs} need you</span>
      )}
    </h2>
  )
}

/** Ideas → Assessing → Building → Landed, each scrolling on its own; Parked folds under Ideas. */
function Columns({ rows, loading }: { rows: Row[]; loading: boolean }) {
  const now = useNow(60_000)
  const [parkedOpen, setParkedOpen] = useState(false)
  const of = (column: Column) => rows.filter((row) => row.column === column).toSorted(byUrgency)
  // A parked idea whose branch still asks you something stays in view; the rest fold away.
  const [asking, parked] = partition(of('parked'), (row) => row.asks.length > 0)
  const blank = !loading && rows.length === 0
  return (
    <main className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto px-4 pt-4" data-ideas-board>
      {columns
        .filter((column) => column.id !== 'parked')
        .map((column) => {
          const items = of(column.id)
          return (
            <section
              className={cn(
                'flex min-h-0 w-0 min-w-52 flex-1 flex-col gap-2',
                // A column holding a decision widens, so its answer card reads like it does in the chat.
                (items.some((row) => row.asks.length > 0) ||
                  (column.id === 'ideas' && asking.length > 0)) &&
                  'min-w-72 flex-[1.75]',
              )}
              data-ideas-column={column.id}
              key={column.id}
            >
              <ColumnHead label={column.label} loading={loading} rows={items} />
              <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 pb-4">
                {column.id === 'ideas' && <AddIdea />}
                {column.id === 'ideas' && blank && <Welcome />}
                {items.map((row) => (
                  <IdeaCard key={row.idea.id} now={now} row={row} />
                ))}
                {!loading && !items.length && empty[column.id] && (
                  <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-[12px] text-muted-foreground/70">
                    {empty[column.id]}
                  </p>
                )}
                {column.id === 'ideas' &&
                  asking.map((row) => <IdeaCard key={row.idea.id} now={now} row={row} />)}
                {column.id === 'ideas' && parked.length > 0 && (
                  <Fold count={parked.length} open={parkedOpen} setOpen={setParkedOpen}>
                    {parked.map((row) => (
                      <IdeaCard key={row.idea.id} now={now} row={row} />
                    ))}
                  </Fold>
                )}
              </div>
            </section>
          )
        })}
    </main>
  )
}

const partition = <T,>(items: T[], test: (item: T) => boolean) =>
  [items.filter(test), items.filter((item) => !test(item))] as const

/** Parked ideas, folded away: parked by you, or branches concluded without landing. */
function Fold({
  count,
  open,
  setOpen,
  children,
}: {
  count: number
  open: boolean
  setOpen: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="mt-2 flex flex-col gap-2" data-ideas-parked>
      <button
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 px-1 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
        Parked
        <span className="tracking-normal text-muted-foreground/60">{count}</span>
      </button>
      {open && children}
    </div>
  )
}

/** A new board: what it is for, under the field that starts it. */
function Welcome() {
  return (
    <div className="flex flex-col items-start gap-1.5 px-1 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
      <LightbulbIcon className="size-4 text-brand" />
      <p className="text-foreground/90">Collect ideas here.</p>
      <p>
        Launch one and @ultimate starts a branch for it. Follow it to landed on this board, and
        answer what it asks you right on its card.
      </p>
    </div>
  )
}

type Filter = 'all' | 'needs' | Column

/** The order of the phone's list under All: what needs you, then work under way, then ideas, then what landed. */
const byPhoneOrder = byUrgencyAcross(['building', 'assessing', 'ideas', 'landed', 'parked'])

/** The phone's board: filter pills with counts over one list, what needs you first, each card with its stage. */
function PhoneList({ rows, loading }: { rows: Row[]; loading: boolean }) {
  const now = useNow(60_000)
  const [filter, setFilter] = useState<Filter>('all')
  const needs = rows.filter((row) => row.asks.length > 0)
  const count = (column: Column) => rows.filter((row) => row.column === column).length
  // All leaves parked ideas out, unless their branch still asks you something.
  const all = rows.filter((row) => row.column !== 'parked' || row.asks.length > 0)
  const listed = (
    filter === 'all'
      ? all
      : rows.filter((row) => (filter === 'needs' ? row.asks.length > 0 : row.column === filter))
  ).toSorted(byPhoneOrder)
  const pills: { id: Filter; label: string; count: number; tone?: string }[] = [
    { id: 'all', label: 'All', count: all.length },
    ...(needs.length ? [{ id: 'needs' as const, label: 'Needs you', count: needs.length }] : []),
    ...columns
      .map((column) => ({ id: column.id, label: column.label, count: count(column.id) }))
      .filter((pill) => pill.count > 0 || pill.id === filter),
  ]
  return (
    <main className="flex min-h-0 flex-1 flex-col" data-ideas-board="phone">
      <nav
        aria-label="Stages"
        className={cn(
          'flex shrink-0 gap-1.5 overflow-x-auto border-b border-border/70 px-3 py-2 [scrollbar-width:none]',
          // Counts before the ideas load would read as an empty board.
          loading && 'invisible',
        )}
      >
        {pills.map((pill) => (
          <button
            aria-pressed={filter === pill.id}
            className={cn(
              'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] text-muted-foreground',
              pill.id === 'needs'
                ? 'border-warning/50 text-warning'
                : 'border-border/70 hover:text-foreground',
              filter === pill.id &&
                (pill.id === 'needs' ? 'bg-warning/15' : 'border-border bg-muted text-foreground'),
            )}
            data-ideas-filter={pill.id}
            key={pill.id}
            onClick={() => setFilter(filter === pill.id && pill.id !== 'all' ? 'all' : pill.id)}
            type="button"
          >
            {pill.label}
            <span className="opacity-70">{pill.count}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pt-3 pb-6">
        {(filter === 'all' || filter === 'ideas') && <AddIdea />}
        {!loading && rows.length === 0 && <Welcome />}
        {listed.map((row) => (
          <IdeaCard key={row.idea.id} now={now} pill row={row} />
        ))}
        {rows.length > 0 && !listed.length && (
          <p className="px-1 py-6 text-center text-[12px] text-muted-foreground/70">
            Nothing here.
          </p>
        )}
      </div>
    </main>
  )
}
