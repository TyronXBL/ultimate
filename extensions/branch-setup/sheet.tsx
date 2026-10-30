/**
 * The branch setup in @ultimate's composer: a pill beside the side chat switch, and the sheet it opens with one row per
 * agent (model and thinking level), the setups to start from, and saving the current one as a preset.
 */
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  GitBranchIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, errorMessage, touchKeyboard, useModels, useViewport } from '@/sdk'
import { FamilyDot, ModelRow } from '../models/ui.tsx'
import { DeletePresetAction, SavePresetAction } from './refs.ts'
import type { Agents } from './refs.ts'
import {
  decode,
  encode,
  modelId,
  pickLabel,
  setSetup,
  useAgentRows,
  useChoices,
  useSetup,
} from './state.tsx'
import type { AgentRow, Pick } from './state.tsx'

const focusComposer = () => {
  // A touch keyboard would slide back up over the transcript.
  if (!touchKeyboard()) document.getElementById('composer-input')?.focus()
}

/** The pill above @ultimate's composer: quiet until the next branch has a setup, then it says how much changed. */
export function SetupControl({ side, normal }: { side: boolean; normal: () => void }) {
  const phone = useViewport() === 'phone'
  const [open, setOpen] = useState(false)
  const count = Object.keys(useSetup()).length
  const armed = count > 0
  const change = (next: boolean) => {
    setOpen(next)
    if (!next) focusComposer()
  }
  const pill = (
    <button
      aria-label={
        armed ? `Branch setup: ${count} changed for the next branch` : 'Set up the next branch'
      }
      className={cn(
        'flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 font-mono text-[10.5px] whitespace-nowrap outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-7 pointer-coarse:px-2.5',
        armed && !side
          ? 'bg-background text-brand shadow-xs ring-1 ring-brand/40'
          : 'bg-muted/60 text-muted-foreground/80 hover:text-foreground',
      )}
      data-branch-setup={armed ? (side ? 'paused' : 'armed') : 'off'}
      onClick={() => change(!open)}
      title={
        armed && side
          ? 'Paused while side chat is on · Tab back to normal to use it'
          : armed
            ? 'Send starts one branch on this setup'
            : 'Pick each agent’s model for the next branch'
      }
      type="button"
    >
      <GitBranchIcon className="size-2.5" />
      {/* Armed on a phone, the count needs the room: "Setup · 2 changed". */}
      <span className={cn(armed && 'max-sm:hidden')}>Branch setup</span>
      {armed && <span className="sm:hidden">Setup</span>}
      {armed && (
        <span className={side ? 'text-muted-foreground/70' : 'text-brand'}>· {count} changed</span>
      )}
    </button>
  )
  const sheet = <Sheet onArm={normal} onDone={() => change(false)} phone={phone} />
  if (phone)
    return (
      <>
        {pill}
        <Dialog onOpenChange={change} open={open}>
          <DialogContent
            className="top-auto bottom-0 left-0 flex max-h-[85dvh] max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-2xl rounded-b-none border-x-0 border-b-0 p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-bottom-8"
            // The sheet is for tapping rows; a keyboard would cover it.
            onOpenAutoFocus={(event) => event.preventDefault()}
            showCloseButton={false}
          >
            <DialogDescription className="sr-only">
              The model and thinking level of each agent, for the next branch only.
            </DialogDescription>
            {sheet}
          </DialogContent>
        </Dialog>
      </>
    )
  return (
    <Popover onOpenChange={change} open={open}>
      <PopoverTrigger asChild>{pill}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(34rem,calc(100vw-1.5rem))] flex-col overflow-hidden p-0"
        collisionPadding={12}
        onCloseAutoFocus={(event) => event.preventDefault()}
        side="top"
        sideOffset={8}
      >
        {sheet}
      </PopoverContent>
    </Popover>
  )
}

/** The sheet's body: header with the setups to start from, the agents, and the footer. */
function Sheet({
  onArm,
  onDone,
  phone,
}: {
  onArm: () => void
  onDone: () => void
  phone: boolean
}) {
  const { rows } = useAgentRows()
  const setup = useSetup()
  const models = useModels()
  const choices = useChoices(rows, setup)
  const [picking, setPicking] = useState<AgentRow>()
  const changed = Object.keys(setup).length
  const apply = (next: Agents) => {
    setSetup(next)
    if (Object.keys(next).length) onArm()
  }
  const set = (row: AgentRow, pick: Pick) => {
    const rest = Object.fromEntries(Object.entries(setup).filter(([name]) => name !== row.name))
    apply(encode(pick) === encode(row.base) ? rest : { ...rest, [row.name]: encode(pick) })
  }
  const title = phone ? (
    <DialogTitle className="text-[13px] font-semibold">Branch setup</DialogTitle>
  ) : (
    <h2 className="text-[13px] font-semibold">Branch setup</h2>
  )
  if (picking)
    return (
      <ModelList
        current={setup[picking.name] ? decode(setup[picking.name]) : picking.base}
        onBack={() => setPicking(undefined)}
        onPick={(model) => {
          const pick = setup[picking.name] ? decode(setup[picking.name]) : picking.base
          const supported = levelsOf(models, model)
          const thinking =
            pick.thinking && supported.includes(pick.thinking) ? pick.thinking : undefined
          set(picking, { model, ...(thinking ? { thinking } : {}) })
          setPicking(undefined)
        }}
        row={picking}
      />
    )
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 py-2 pr-2 pl-3">
        <GitBranchIcon className="size-3.5 shrink-0 text-brand" />
        <div className="flex min-w-0 items-baseline gap-2">
          {title}
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            for the next branch only
          </span>
        </div>
        <Presets apply={apply} choices={choices} disabled={!rows} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5" data-branch-setup-agents>
        {rows ? (
          <Rows onModel={setPicking} onSet={set} rows={rows} setup={setup} />
        ) : (
          <p className="px-3 py-6 text-center font-mono text-[11px] text-muted-foreground">
            Reading the agents…
          </p>
        )}
      </div>
      <Footer changed={changed} onDone={onDone} refetch={choices.refetch} setup={setup} />
    </>
  )
}

// Pi's levels, for a model the catalogue does not know.
const allLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** The thinking levels `model` supports; none for a model without reasoning. */
function levelsOf(models: ReturnType<typeof useModels>, model: string) {
  const found = models?.models.find((item) => `${item.provider}/${item.id}` === model)
  return found ? (found.reasoning ? found.thinkingLevels : []) : allLevels
}

function Rows({
  rows,
  setup,
  onSet,
  onModel,
}: {
  rows: readonly AgentRow[]
  setup: Agents
  onSet: (row: AgentRow, pick: Pick) => void
  onModel: (row: AgentRow) => void
}) {
  const models = useModels()
  const main = rows.filter((row) => !row.more)
  const more = rows.filter((row) => row.more)
  const hidden = more.filter((item) => setup[item.name]).length
  const [showMore, setShowMore] = useState(hidden > 0)
  const row = (item: AgentRow) => (
    <AgentLine
      key={item.name}
      levels={levelsOf(models, setup[item.name] ? decode(setup[item.name]).model : item.base.model)}
      onModel={() => onModel(item)}
      onSet={(pick) => onSet(item, pick)}
      row={item}
      value={setup[item.name]}
    />
  )
  return (
    <>
      {main.map(row)}
      {more.length > 0 && (
        <>
          <button
            aria-expanded={showMore}
            className="mx-3 mt-1 flex cursor-pointer items-center gap-1 rounded-sm py-1 font-mono text-[10.5px] text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setShowMore(!showMore)}
            type="button"
          >
            {showMore ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
            {more.length} more {more.length === 1 ? 'agent' : 'agents'}
            {!showMore && (
              <span className="truncate text-muted-foreground/60">
                · {more.map((item) => item.name).join(', ')}
              </span>
            )}
            {!showMore && hidden > 0 && (
              <span className="shrink-0 text-brand">· {hidden} changed</span>
            )}
          </button>
          {showMore && more.map(row)}
        </>
      )}
    </>
  )
}

const control =
  'flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/80 bg-background px-2 font-mono text-[12px] outline-none hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:h-9'

/** One agent: its name, model and thinking level; a changed one says what it was and resets. */
function AgentLine({
  row,
  value,
  levels,
  onSet,
  onModel,
}: {
  row: AgentRow
  value: string | undefined
  levels: readonly string[]
  onSet: (pick: Pick) => void
  onModel: () => void
}) {
  const pick = value ? decode(value) : row.base
  const changed = value !== undefined
  const label = row.under ? row.name.slice(row.under.length + 1) : row.name
  return (
    <div
      className={cn(
        'grid grid-cols-[7.75rem_minmax(0,1fr)_6.25rem_1.75rem] items-center gap-x-1.5 px-3 py-1 max-sm:grid-cols-[6.25rem_minmax(0,1fr)_4.75rem_1.75rem] max-sm:gap-x-1',
        changed && 'bg-brand/[0.04]',
      )}
      data-branch-setup-agent={row.name}
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]',
          row.under && 'pl-3 max-sm:pl-1.5',
          changed ? 'text-foreground' : 'text-muted-foreground',
        )}
        title={row.name}
      >
        {row.under && <span className="-ml-1 text-muted-foreground/40">└</span>}
        <span className="truncate">{label}</span>
        {changed && (
          <span aria-label="changed" className="size-1.5 shrink-0 rounded-full bg-brand" />
        )}
      </span>
      <button
        aria-label={`${row.name} model`}
        className={cn(control, changed && pick.model !== row.base.model && 'text-brand')}
        onClick={onModel}
        type="button"
      >
        <span className="min-w-0 truncate">{modelId(pick.model)}</span>
        <ChevronsUpDownIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
      </button>
      <label className="relative min-w-0">
        <span className="sr-only">{row.name} thinking</span>
        <select
          className={cn(
            control,
            'w-full appearance-none pr-5 disabled:cursor-default disabled:opacity-50',
            changed && pick.thinking !== row.base.thinking && 'text-brand',
          )}
          disabled={levels.length === 0}
          onChange={(event) =>
            onSet({
              model: pick.model,
              ...(event.target.value ? { thinking: event.target.value } : {}),
            })
          }
          value={pick.thinking ?? ''}
        >
          <option value="">{levels.length ? 'default' : 'no thinking'}</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
      </label>
      {changed ? (
        <button
          aria-label={`Reset ${row.name} to ${pickLabel(row.base)}`}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:size-9"
          onClick={() => onSet(row.base)}
          title={`Reset to ${pickLabel(row.base)}`}
          type="button"
        >
          <RotateCcwIcon className="size-3" />
        </button>
      ) : (
        <span />
      )}
      {changed && (
        <span className="col-start-2 col-end-4 truncate pt-0.5 font-mono text-[10.5px] text-muted-foreground/70">
          was {pickLabel(row.base)}
        </span>
      )}
    </div>
  )
}

/** The models with a login here, searchable, for one agent; the sheet's rows come back once one is picked. */
function ModelList({
  row,
  current,
  onPick,
  onBack,
}: {
  row: AgentRow
  current: Pick
  onPick: (model: string) => void
  onBack: () => void
}) {
  const models = useModels()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const found = (models?.models ?? []).filter(
      (model) =>
        model.available &&
        terms.every((term) =>
          `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
        ),
    )
    return [...Map.groupBy(found, (model) => model.provider)]
  }, [models, query])
  return (
    <Command
      className="flex min-h-0 flex-1 flex-col rounded-none bg-transparent [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase"
      defaultValue={current.model}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onBack()
      }}
      shouldFilter={false}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 py-1.5 pr-3 pl-1.5 font-mono text-[11px] text-muted-foreground">
        <button
          aria-label="Back to the agents"
          className="flex size-7 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onBack}
          type="button"
        >
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <span className="text-foreground">{row.name}</span>
        <span className="truncate">model · was {modelId(row.base.model)}</span>
      </header>
      <CommandInput
        autoFocus={!touchKeyboard()}
        className="text-[13px]"
        onValueChange={setQuery}
        placeholder="Search logged-in models…"
        value={query}
      />
      <CommandList className="max-h-none min-h-0 flex-1 overflow-x-hidden">
        <CommandEmpty className="py-6 text-center font-mono text-[11px] text-muted-foreground">
          No logged-in model matches.
        </CommandEmpty>
        {groups.map(([provider, items]) => (
          <Fragment key={provider}>
            <CommandGroup heading={provider}>
              {items.map((model) => {
                const name = `${model.provider}/${model.id}`
                return (
                  <ModelRow
                    current={name === current.model}
                    key={name}
                    model={model}
                    onSelect={() => onPick(name)}
                  />
                )
              })}
            </CommandGroup>
          </Fragment>
        ))}
      </CommandList>
    </Command>
  )
}

/** The setups to start from: Defaults, one family for every agent, the saved presets (each deletable). */
function Presets({
  choices: { choices, current, refetch },
  disabled,
  apply,
}: {
  choices: ReturnType<typeof useChoices>
  disabled: boolean
  apply: (agents: Agents) => void
}) {
  const [error, setError] = useState<string>()
  const remove = (name: string) =>
    api.action(DeletePresetAction, { name }).then(
      () => refetch(),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  const item = (choice: (typeof choices)[number], extra?: ReactNode) => (
    <DropdownMenuItem
      className="group/preset cursor-pointer gap-2 py-1 font-mono text-[12px] pointer-coarse:min-h-10"
      data-branch-setup-preset={choice.key}
      key={choice.key}
      onSelect={() => apply(choice.agents)}
    >
      <CheckIcon className={cn('size-3.5', current === choice ? 'text-brand' : 'opacity-0')} />
      {choice.family ? (
        <FamilyDot color={choice.family.color} />
      ) : (
        <span className="size-2 shrink-0" />
      )}
      <span className="max-w-[60%] shrink-0 truncate text-foreground">{choice.label}</span>
      <span className="ml-auto min-w-0 truncate pl-3 text-right text-[11px] text-muted-foreground">
        {choice.detail}
      </span>
      {extra}
    </DropdownMenuItem>
  )
  const saved = choices.filter((choice) => choice.saved)
  return (
    <DropdownMenu modal={false} onOpenChange={() => setError(undefined)}>
      <DropdownMenuTrigger
        className="ml-auto flex h-7 max-w-[11rem] shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-mono text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent"
        data-branch-setup-presets
        disabled={disabled}
      >
        <span className="truncate">{current?.label ?? 'Custom'}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))]">
        {choices.filter((choice) => !choice.saved).map((choice) => item(choice))}
        {saved.length > 0 && (
          <DropdownMenuLabel className="pt-2 pb-1 font-mono text-[10.5px] font-normal tracking-wider text-muted-foreground uppercase">
            Saved
          </DropdownMenuLabel>
        )}
        {saved.map((choice) =>
          item(
            choice,
            <button
              aria-label={`Delete preset ${choice.label}`}
              className="-my-1 -mr-1 flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover/preset:opacity-100 group-focus/preset:opacity-100 hover:text-error pointer-coarse:opacity-100"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                // oxlint-disable-next-line typescript/no-floating-promises -- remove shows its failure in the menu.
                void remove(choice.label)
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title="Delete preset"
              type="button"
            >
              <Trash2Icon className="size-3" />
            </button>,
          ),
        )}
        {error && <p className="px-2 py-1 font-mono text-[11px] text-error">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Save the setup as a preset, clear it, or close the sheet. */
function Footer({
  setup,
  changed,
  refetch,
  onDone,
}: {
  setup: Agents
  changed: number
  refetch: () => Promise<unknown>
  onDone: () => void
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const save = async () => {
    try {
      await api.action(SavePresetAction, { name: name.trim(), agents: setup })
      await refetch()
      setNaming(false)
      setName('')
      setError(undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <footer className="shrink-0 border-t border-border/60 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {error && <p className="pb-1.5 font-mono text-[11px] break-words text-error">{error}</p>}
      {naming ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            // oxlint-disable-next-line typescript/no-floating-promises -- save shows its failure above the form.
            if (name.trim()) void save()
          }}
        >
          <input
            aria-label="Preset name"
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-md border border-border/80 bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              setNaming(false)
            }}
            placeholder="Preset name"
            value={name}
          />
          <Button disabled={!name.trim()} size="sm" type="submit" variant="outline">
            Save
          </Button>
          <Button onClick={() => setNaming(false)} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <button
            className="mr-auto cursor-pointer rounded-sm font-mono text-[11px] whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted-foreground"
            disabled={changed === 0}
            onClick={() => setNaming(true)}
            type="button"
          >
            Save as preset…
          </button>
          <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground/70 max-sm:hidden">
            {changed ? `${changed} changed · Send starts the branch` : 'Nothing changed'}
          </span>
          {changed > 0 && (
            <Button
              className="text-muted-foreground"
              onClick={() => setSetup({})}
              size="sm"
              variant="ghost"
            >
              Clear
            </Button>
          )}
          <Button onClick={onDone} size="sm" variant="outline">
            Done
          </Button>
        </div>
      )}
    </footer>
  )
}
