import {
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { cn, useModels } from '@/sdk'
import type { ModelsResponse } from '@/sdk'

type ModelInfo = ModelsResponse['models'][number]
export type ModelRef = { provider: string; modelId: string }

/** A labelled row of the config form; `hint` explains the field under it. */
export function Field({
  label,
  hint,
  aside,
  children,
}: {
  label: string
  hint?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        {label}
        {aside && <span className="ml-auto tracking-normal normal-case">{aside}</span>}
      </div>
      {children}
      {hint && <p className="text-[11.5px] leading-snug text-muted-foreground/80">{hint}</p>}
    </div>
  )
}

export function StandingField({
  value,
  onChange,
}: {
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Field
      label="Standing agent"
      hint="One conversation per project, addressed by @name. Its isolate setting is ignored."
    >
      <label className="flex items-center justify-between rounded-md border border-border/80 bg-background px-2 py-1.5 text-[13px]">
        Available by name
        <Switch aria-label="Standing agent" checked={value} onCheckedChange={onChange} />
      </label>
    </Field>
  )
}

export function SummariesField({
  value,
  onChange,
}: {
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <Field
      label="Automatic summaries"
      hint={
        value
          ? 'The summary model names its conversations and describes each reply for the sidebar.'
          : 'Its conversations keep the title they were given; the summary model answers only explicit calls.'
      }
    >
      <label className="flex items-center justify-between rounded-md border border-border/80 bg-background px-2 py-1.5 text-[13px]">
        Title and reply activity
        <Switch aria-label="Automatic summaries" checked={value} onCheckedChange={onChange} />
      </label>
    </Field>
  )
}

export const inputClass =
  'w-full rounded-md border border-border/80 bg-background px-2 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-error/70'

/** Exclusive choices as one control; `value` null selects none. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null
  options: readonly { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div
      aria-label={label}
      className="flex flex-wrap rounded-md border border-border/80 bg-background p-0.5 font-mono text-[11px]"
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn(
            'flex h-6 flex-1 items-center justify-center rounded-[5px] px-1.5 whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            option.value === value && 'bg-accent text-foreground shadow-xs',
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const LIMIT = 150
// Pi's levels, for a model the catalogue does not know.
const allLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The levels a model supports, from the catalogue the models extension shows. */
export function thinkingLevels(models: ModelsResponse | undefined, ref: ModelRef | undefined) {
  const model = ref
    ? models?.models.find((m) => m.provider === ref.provider && m.id === ref.modelId)
    : undefined
  return model ? model.thinkingLevels : allLevels
}

/** A model, or the main conversation's when `value` is null. */
export function ModelField({
  value,
  inherited,
  onChange,
}: {
  value: ModelRef | null
  inherited?: ModelRef
  onChange: (value: ModelRef | null) => void
}) {
  const shown = value ?? inherited
  return (
    <ModelPicker inherit={{ model: inherited }} onChange={onChange} value={value}>
      <button
        className={cn(inputClass, 'flex items-center gap-2 text-left font-mono text-[12px]')}
        type="button"
      >
        {value ? (
          <>
            <span className="text-muted-foreground">{value.provider}/</span>
            <span className="min-w-0 truncate">{value.modelId}</span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">inherit</span>
            {shown && (
              <span className="min-w-0 truncate text-muted-foreground/70">· {shown.modelId}</span>
            )}
          </>
        )}
        <ChevronsUpDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </ModelPicker>
  )
}

export type BackupModel = ModelRef & { thinking?: string }

/**
 * The ordered backup models, each picked like Model. A row keeps a thinking level its file sets, shown after the id,
 * while the model it is for supports it.
 */
export function BackupModelsField({
  value,
  onChange,
}: {
  value: BackupModel[]
  onChange: (value: BackupModel[]) => void
}) {
  const models = useModels()
  const replace = (index: number, model: ModelRef) => {
    const { thinking } = value[index]
    const kept = thinking && thinkingLevels(models, model).includes(thinking)
    onChange(value.with(index, { ...model, ...(kept ? { thinking } : {}) }))
  }
  const move = (index: number) =>
    onChange(value.toSpliced(index - 1, 2, value[index], value[index - 1]))
  return (
    <Field
      hint={
        value.length
          ? 'Tried in order when the model hits a rate limit, overload or quota error; one without a login here is skipped.'
          : 'None. A conversation switches to one when its model hits a rate limit, overload or quota error.'
      }
      label="Backup models"
    >
      {value.length > 0 && (
        <ol className="flex flex-col gap-1">
          {value.map((model, index) => (
            <li
              className="group/backup flex items-center gap-1"
              key={`${index}:${model.provider}/${model.modelId}`}
            >
              <span className="w-3.5 shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
                {index + 1}
              </span>
              <ModelPicker onChange={(next) => next && replace(index, next)} value={model}>
                <button
                  aria-label={`Backup model ${index + 1}`}
                  className={cn(
                    inputClass,
                    'flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-[12px]',
                  )}
                  type="button"
                >
                  <span className="min-w-0 truncate">
                    <span className="text-muted-foreground">{model.provider}/</span>
                    {model.modelId}
                    {model.thinking && (
                      <span className="text-muted-foreground">:{model.thinking}</span>
                    )}
                  </span>
                  <ChevronsUpDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </ModelPicker>
              <Button
                aria-label={`Try ${model.modelId} earlier`}
                className="size-7 text-muted-foreground hover:text-foreground disabled:opacity-0"
                disabled={index === 0}
                onClick={() => move(index)}
                size="icon-sm"
                title="Try earlier"
                variant="ghost"
              >
                <ArrowUpIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={`Remove ${model.modelId}`}
                className="size-7 text-muted-foreground hover:text-error"
                onClick={() => onChange(value.toSpliced(index, 1))}
                size="icon-sm"
                title="Remove"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {/* Under a list, it lines up with the model column, between the order numbers and the row buttons. */}
      <div className={cn('flex', value.length > 0 && 'pr-16 pl-[1.125rem]')}>
        <ModelPicker onChange={(next) => next && onChange([...value, next])} value={null}>
          <button
            className={cn(
              inputClass,
              'flex items-center gap-1.5 border-dashed text-left font-mono text-[12px] text-muted-foreground transition-colors hover:border-border hover:text-foreground',
            )}
            type="button"
          >
            <PlusIcon className="size-3.5" />
            Add backup
          </button>
        </ModelPicker>
      </div>
    </Field>
  )
}

/**
 * The searchable model list of the models extension's picker, opened by `children`; `inherit` adds the main
 * conversation's model as the null choice.
 */
function ModelPicker({
  value,
  inherit,
  onChange,
  children,
}: {
  value: ModelRef | null
  inherit?: { model?: ModelRef }
  onChange: (value: ModelRef | null) => void
  children: ReactNode
}) {
  const inherited = inherit?.model
  const models = useModels()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = models?.models ?? []
    const found = terms.length
      ? all.filter((model) =>
          terms.every((term) =>
            `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
          ),
        )
      : all.filter(
          (model) =>
            model.available || (model.provider === value?.provider && model.id === value.modelId),
        )
    return [
      ...Map.groupBy(
        found.toSorted((a, b) => Number(b.available) - Number(a.available)).slice(0, LIMIT),
        (model) => model.provider,
      ),
    ]
  }, [models, query, value])
  const choose = (next: ModelRef | null) => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(34rem,90vw)] p-0">
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase"
          defaultValue={
            value ? `${value.provider}/${value.modelId}` : inherit ? 'inherit' : undefined
          }
          shouldFilter={false}
        >
          <CommandInput
            className="text-[13px]"
            onValueChange={setQuery}
            placeholder={`Search ${(models?.models.length ?? 0).toLocaleString()} models…`}
            value={query}
          />
          <CommandList className="max-h-[45vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              No model matches.
            </CommandEmpty>
            {!query && inherit && (
              <CommandGroup heading="Main conversation">
                <CommandItem
                  className="gap-2 py-1 font-mono text-[12px]"
                  onSelect={() => choose(null)}
                  value="inherit"
                >
                  <CheckIcon className={cn('size-3.5', value ? 'opacity-0' : 'text-brand')} />
                  inherit
                  <span className="truncate text-muted-foreground">
                    {inherited ? `${inherited.provider}/${inherited.modelId}` : 'its model'}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map(([provider, items]) => (
              <Fragment key={provider}>
                <CommandGroup heading={provider}>
                  {items.map((model) => (
                    <ModelRow
                      current={model.provider === value?.provider && model.id === value.modelId}
                      key={`${model.provider}/${model.id}`}
                      model={model}
                      onSelect={() => choose({ provider: model.provider, modelId: model.id })}
                    />
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
          <div className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {query ? 'all providers' : 'logged-in providers · type to search all'}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ModelRow({
  model,
  current,
  onSelect,
}: {
  model: ModelInfo
  current: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem
      className={cn('gap-2 py-1 font-mono text-[12px]', !model.available && 'opacity-60')}
      onSelect={onSelect}
      title={model.available ? undefined : 'Not logged in to this provider'}
      value={`${model.provider}/${model.id}`}
    >
      <CheckIcon className={cn('size-3.5', current ? 'text-brand' : 'opacity-0')} />
      <span className={cn('shrink-0', current ? 'text-brand' : 'text-foreground')}>{model.id}</span>
      {model.name !== model.id && (
        <span className="min-w-0 truncate font-sans text-[12px] text-muted-foreground/80">
          {model.name}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1 pl-3 text-[11px] text-muted-foreground">
        {model.reasoning ? (
          <>
            <BrainIcon className="size-3" />
            {model.thinkingLevels.filter((level) => level !== 'off').at(-1)}
          </>
        ) : (
          <span className="text-muted-foreground/40">no thinking</span>
        )}
      </span>
    </CommandItem>
  )
}

/** The main conversation's tools as a checklist; `value` null inherits all except subagent. */
export function ToolsField({
  value,
  tools,
  onChange,
}: {
  value: string[] | null
  tools: { name: string; description: string }[]
  onChange: (value: string[] | null) => void
}) {
  const inherited = tools.filter((tool) => tool.name !== 'subagent').map((tool) => tool.name)
  const selected = value ?? inherited
  const known = new Set(tools.map((tool) => tool.name))
  const unknown = (value ?? []).filter((name) => !known.has(name))
  return (
    <Field
      aside={
        <label className="flex items-center gap-1.5 font-sans text-[11.5px] text-muted-foreground">
          inherit all
          <Switch
            checked={value === null}
            aria-label="Inherit all tools"
            onCheckedChange={(inherit) => onChange(inherit ? null : inherited)}
          />
        </label>
      }
      hint={
        value === null
          ? `${inherited.length} of ${tools.length} tools inherited from the main conversation; subagent requires explicit selection.`
          : `${value.length} of ${tools.length} tools selected. Select subagent explicitly to allow child delegation.`
      }
      label="Tools"
    >
      <div
        className={cn(
          'grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-md border border-border/70 px-2 py-1.5 font-mono text-[11.5px]',
          value === null && 'opacity-50',
        )}
      >
        {tools.map((tool) => (
          <label
            className="flex min-w-0 items-center gap-1.5 py-0.5"
            key={tool.name}
            title={tool.description}
          >
            <input
              checked={selected.includes(tool.name)}
              className="size-3 shrink-0 accent-brand"
              disabled={value === null}
              onChange={(event) =>
                value &&
                onChange(
                  event.target.checked
                    ? tools.map((t) => t.name).filter((n) => n === tool.name || value.includes(n))
                    : value.filter((name) => name !== tool.name),
                )
              }
              type="checkbox"
            />
            <span className="truncate">{tool.name}</span>
          </label>
        ))}
        {unknown.map((name) => (
          <label
            className="flex min-w-0 items-center gap-1.5 py-0.5 text-error"
            key={name}
            title="Not a tool of the main conversation: start refuses this definition"
          >
            <input
              checked
              className="size-3 shrink-0 accent-error"
              onChange={() => value && onChange(value.filter((n) => n !== name))}
              type="checkbox"
            />
            <span className="truncate">{name}</span>
          </label>
        ))}
      </div>
    </Field>
  )
}

/** The instructions: written as Markdown, previewed as the transcript renders it, and the file as saved. */
export function InstructionsEditor({
  value,
  onChange,
  file,
}: {
  value: string
  onChange: (value: string) => void
  file?: string
}) {
  const [tab, setTab] = useState<'write' | 'preview' | 'file'>('write')
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/80 bg-background focus-within:border-ring">
      <div className="flex items-center gap-1 border-b border-border/70 px-1.5 py-1 font-mono text-[11px]">
        {(file === undefined
          ? (['write', 'preview'] as const)
          : (['write', 'preview', 'file'] as const)
        ).map((name) => (
          <button
            aria-pressed={tab === name}
            className={cn(
              'h-6 rounded-[5px] px-2 text-muted-foreground hover:text-foreground',
              tab === name && 'bg-accent text-foreground',
            )}
            key={name}
            onClick={() => setTab(name)}
            type="button"
          >
            {name === 'write' ? 'Write' : name === 'preview' ? 'Preview' : 'File'}
          </button>
        ))}
        <span className="ml-auto pr-1.5 text-muted-foreground/70">
          Markdown · the system prompt
        </span>
      </div>
      {tab === 'write' ? (
        <textarea
          aria-label="Instructions"
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
          onChange={(event) => onChange(event.target.value)}
          placeholder="What this agent does and how it reports back…"
          spellCheck={false}
          value={value}
        />
      ) : tab === 'preview' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[13px]">
          {value.trim() ? (
            <MessageResponse>{value}</MessageResponse>
          ) : (
            <p className="text-muted-foreground/70">Nothing to preview.</p>
          )}
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {file}
        </pre>
      )}
    </div>
  )
}
