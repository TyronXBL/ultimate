import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  EllipsisIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  api,
  cn,
  ConversationScope,
  errorMessage,
  events,
  formatAgo,
  Provided,
  useUltimate,
} from '@/sdk'
import { ConversationPhase, useOverview } from '../conversations/ui.tsx'
import { MessageAnswers } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { useBranchState } from '../sidebar/ui.tsx'
import type { BranchTone } from '../sidebar/ui.tsx'
import { Review } from '../workspaces/ui.tsx'
import type { WorkspaceConversation } from '../workspaces/ui.tsx'
import type { Row } from './data.tsx'
import { IdeaForm } from './form.tsx'
import { Thumbnails, usePictures } from './pictures.tsx'
import { LaunchAction, ParkAction, RemoveAction, UpdateAction } from './refs.ts'
import type { LaunchSize } from './refs.ts'
import { columns } from './stage.ts'

/** Runs a board action, reporting a failure on the card. */
function useRun() {
  const [error, setError] = useState<string>()
  const run = (action: Promise<unknown>) => {
    setError(undefined)
    return action.then(
      () => true,
      (cause: unknown) => {
        setError(errorMessage(cause))
        return false
      },
    )
  }
  return { error, run }
}

/**
 * One idea: its title, notes while it is only an idea, and a meta line with where it stands. A launched one names its
 * branch, which opens it; one that waits on you says so in the waiting tone and carries the real answer cards of the
 * decisions its branch asked through @ultimate, answered right here.
 */
export function IdeaCard({ row, now, pill }: { row: Row; now: number; pill?: boolean }) {
  const { idea, branch, asks } = row
  const [editing, setEditing] = useState(false)
  const { error, run } = useRun()
  const needs = asks.length > 0
  if (editing)
    return (
      <IdeaForm
        idea={idea}
        onCancel={() => setEditing(false)}
        onSave={async (fields) => {
          const saved = await run(api.action(UpdateAction, { id: idea.id, ...fields }))
          if (saved) setEditing(false)
          return saved
        }}
        error={error}
      />
    )
  return (
    <article
      className={cn(
        'group/idea min-w-0 rounded-md border border-border/70 bg-card px-3 py-2.5',
        needs && 'border-l-2 border-l-warning',
      )}
      data-idea={idea.id}
      data-idea-stage={row.column}
    >
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[13px] leading-snug font-medium break-words text-foreground">
          {idea.title}
        </h3>
        <IdeaMenu onEdit={() => setEditing(true)} row={row} run={run} />
      </div>
      {idea.notes && (row.column === 'ideas' || row.column === 'parked') && (
        <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed whitespace-pre-line text-muted-foreground">
          {idea.notes}
        </p>
      )}
      {idea.images !== undefined && <Pictures entry={idea.images} />}
      <div className="mt-1.5 flex min-w-0 items-center gap-2 font-mono text-[10.5px] leading-4 text-muted-foreground">
        {pill && <StagePill row={row} />}
        <Status row={row} />
        {branch && <BranchLink id={branch.id} />}
        <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
          {[
            ...idea.tags.map((tag) => `#${tag}`),
            ...(idea.by === 'ultimate' ? ['by @ultimate'] : []),
          ].join(' ')}
        </span>
        <span className="shrink-0 text-muted-foreground/60">{formatAgo(row.at, now)}</span>
        {row.column === 'ideas' && (
          <LaunchMenu
            launch={(size) => void run(api.action(LaunchAction, { id: idea.id, size }))}
          />
        )}
      </div>
      {error && <p className="mt-1.5 font-mono text-[11px] break-words text-error">{error}</p>}
      {branch &&
        asks.map((message) => <Ask branch={branch.id} key={message.id} message={message} />)}
    </article>
  )
}

/** An idea's pictures as small thumbnails, loaded only for an idea that has some; a quiet square while they load. */
function Pictures({ entry }: { entry: number }) {
  const images = usePictures(entry)
  if (!images) return <div aria-hidden className="mt-2 size-10 animate-pulse rounded-md bg-muted" />
  return <Thumbnails className="mt-2" images={images} />
}

/** On a phone's single list: the stage an idea is in, quiet unless it landed; the status beside it says it needs you. */
function StagePill({ row }: { row: Row }) {
  const label = columns.find((column) => column.id === row.column)?.label
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border px-1 leading-[15px]',
        row.column === 'landed'
          ? 'border-success/40 text-success'
          : 'border-border text-muted-foreground',
      )}
    >
      {label}
    </span>
  )
}

/** Where the idea stands, in a word: the branch's state as its sidebar row says it, or the board's own. */
function Status({ row }: { row: Row }) {
  if (row.asks.length)
    return (
      <span className="shrink-0 text-warning">
        needs you{row.asks.length > 1 ? ` · ${row.asks.length}` : ''}
      </span>
    )
  if (row.column === 'landed' && row.landed) return <Landed {...row.landed} />
  if (row.note === 'launching')
    return <span className="shrink-0 animate-pulse text-brand">launching</span>
  if (row.note === 'not built') return <span className="shrink-0">not built</span>
  if (row.idea.parked !== undefined) return null
  if (row.branch) return <BranchState branch={row.branch} />
  return null
}

function BranchState({ branch }: { branch: WorkspaceConversation }) {
  const runState = useOverview()[branch.id]?.runState
  const working = branch.busy || runState === 'working'
  return (
    <Provided input={working ? branch.id : undefined} point={ConversationPhase}>
      {(phase) => <StateWord branch={branch} phase={phase} working={working} />}
    </Provided>
  )
}

function StateWord({
  branch,
  working,
  phase,
}: {
  branch: WorkspaceConversation
  working: boolean
  phase?: { word: string; waiting: boolean }
}) {
  const state = useBranchState(branch, working, phase)
  return <span className={cn('shrink-0', tones[state.tone])}>{state.label}</span>
}

/**
 * The branch states' colours on the board. Waiting on @ultimate stays quiet here: the waiting tone means the user.
 */
const tones: Record<BranchTone, string> = {
  failed: 'text-error',
  success: 'text-success',
  brand: 'text-brand',
  waiting: 'text-foreground/70',
  paused: 'text-warning',
  quiet: 'text-muted-foreground/70',
}

/** "landed 1a2b3c4", opening Review of what it brought when it can. */
function Landed({ sha, base }: { sha: string; base?: string }) {
  const label = (
    <>
      <span className="text-success">landed</span> {sha.slice(0, 7)}
    </>
  )
  if (!base) return <span className="shrink-0">{label}</span>
  return (
    <Provided input={`${base}...${sha}`} point={Review}>
      {(open) =>
        open ? (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={open}
            title="Review what it landed"
            type="button"
          >
            {label}
          </button>
        ) : (
          <span className="shrink-0">{label}</span>
        )
      }
    </Provided>
  )
}

/** "#123 ↗": opens the idea's branch on the Agent surface. */
function BranchLink({ id }: { id: number }) {
  const { showSurface, switchConversation } = useUltimate()
  return (
    <button
      className="flex shrink-0 cursor-pointer items-center gap-0.5 hover:text-foreground hover:underline"
      data-idea-branch={id}
      onClick={() => {
        showSurface('agent')
        switchConversation(id)
      }}
      title={`Open branch #${id}`}
      type="button"
    >
      #{id}
      <ArrowUpRightIcon className="size-3" />
    </button>
  )
}

/** The launch button: assess first by default, or build straight away. */
function LaunchMenu({ launch }: { launch: (size: LaunchSize) => void }) {
  const option = (size: LaunchSize, label: string, detail: string) => (
    <DropdownMenuItem
      className="cursor-pointer flex-col items-start gap-0"
      data-idea-launch={size}
      onSelect={() => launch(size)}
    >
      <span className="text-[12.5px]">{label}</span>
      <span className="text-[11px] text-muted-foreground">{detail}</span>
    </DropdownMenuItem>
  )
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className="-my-1 -mr-1.5 flex h-6 shrink-0 pointer-coarse:h-8 pointer-coarse:px-2.5 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-brand outline-none hover:bg-brand/10 focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-brand/10"
        data-idea-launch-menu
      >
        <PlayIcon className="size-3 fill-current" />
        Launch
        <ChevronDownIcon className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {option('assess', 'Assess first', '@ultimate weighs it and brings you choices')}
        {option('build', 'Build it', 'Skip the assessment and start building')}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The card's ⋯ menu: edit, park or bring back, and remove one never launched. */
function IdeaMenu({
  row,
  run,
  onEdit,
}: {
  row: Row
  run: (action: Promise<unknown>) => Promise<boolean>
  onEdit: () => void
}) {
  const { idea } = row
  const item = (icon: ReactNode, label: string, select: () => void, danger = false) => (
    <DropdownMenuItem
      className={cn('cursor-pointer text-[12.5px]', danger && 'text-error focus:text-error')}
      onSelect={select}
    >
      {icon}
      {label}
    </DropdownMenuItem>
  )
  // A branch concluded without landing sits in Parked by itself: the user never parked it, so nothing to bring back.
  const parkable = row.note !== 'not built' && row.column !== 'landed'
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Actions for ${idea.title}`}
        className="-mt-0.5 -mr-1 flex size-5 shrink-0 pointer-coarse:-my-1 pointer-coarse:size-7 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none group-focus-within/idea:opacity-100 group-hover/idea:opacity-100 pointer-coarse:opacity-100 hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:opacity-100"
      >
        <EllipsisIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {item(<PencilIcon />, 'Edit', onEdit)}
        {parkable &&
          (idea.parked === undefined
            ? item(
                <ArchiveIcon />,
                'Park',
                () => void run(api.action(ParkAction, { id: idea.id, parked: true })),
              )
            : item(
                <ArchiveRestoreIcon />,
                'Back to the board',
                () => void run(api.action(ParkAction, { id: idea.id, parked: false })),
              ))}
        {!idea.launch &&
          item(
            <Trash2Icon />,
            'Remove',
            () => void run(api.action(RemoveAction, { id: idea.id })),
            true,
          )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A message's prose on one line, without Markdown marks; its links stay links, so a preview opens from the card. */
function Gist({ text }: { text: string }) {
  const prose = text
    .split('\n')
    .map((line) =>
      line
        .replace(/^[#>\-*\s]+/, '')
        .replace(/[*_`]/g, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
  const parts = prose.split(/(\[[^\]]+\]\([^)\s]+\))/)
  return parts.map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    return link ? (
      <a
        className="text-brand underline-offset-2 hover:underline"
        href={link[2]}
        // oxlint-disable-next-line react/no-array-index-key -- The parts of one fixed text, in order.
        key={index}
        rel="noreferrer"
        target="_blank"
      >
        {link[1]}
      </a>
    ) : (
      part
    )
  })
}

/**
 * One decision the idea's branch waits on: what @ultimate asked, and its real answer card. The card sits in the
 * branch's conversation scope, whose own messages never ask the user, so it never claims the desktop answer keys: only
 * the shown conversation's newest card does, and board cards take clicks.
 */
function Ask({ branch, message }: { branch: number; message: Message }) {
  const { showSurface, switchConversation } = useUltimate()
  const from = typeof message.from === 'number' ? message.from : undefined
  return (
    <div className="-mx-3 -mb-2.5 mt-2.5" data-idea-ask={message.id}>
      <div className="border-t border-border/60 px-3 py-2">
        <p className="line-clamp-3 text-[12.5px] leading-relaxed text-foreground/90">
          <Gist text={message.text} />
        </p>
        {from !== undefined && (
          <button
            className="mt-1 flex cursor-pointer items-center gap-0.5 font-mono text-[10.5px] text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => {
              if (message.call)
                events.emit('messages:open', { conversation: from, call: message.call })
              showSurface('agent')
              switchConversation(from)
            }}
            type="button"
          >
            read in chat
            <ArrowUpRightIcon className="size-3" />
          </button>
        )}
      </div>
      <ConversationScope id={branch}>
        <Provided input={message} point={MessageAnswers}>
          {(answers) => answers}
        </Provided>
      </ConversationScope>
    </div>
  )
}
