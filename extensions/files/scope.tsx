import { ChevronDownIcon, GitBranchIcon } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/sdk'
import type { FileScope } from './refs.ts'

/** The scope on screen as a button; it lists the project checkout and every ready worktree to switch to. */
export function ScopePicker({
  scopes,
  current,
  open,
  onOpenChange,
  onChange,
  compact,
}: {
  scopes: FileScope[] | undefined
  current: number | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (conversation: number | undefined) => void
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const scope = scopes?.find((item) => item.conversation === current)
  const needle = query.trim().toLowerCase()
  const shown = (scopes ?? []).filter(
    (item) =>
      !needle ||
      [String(item.conversation ?? ''), item.branch, item.title ?? ''].some((text) =>
        text.toLowerCase().includes(needle),
      ),
  )
  const choose = (conversation: number | undefined) => {
    onOpenChange(false)
    setQuery('')
    onChange(conversation)
  }
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex h-7 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[12px] hover:bg-accent/60',
            compact && 'h-8 shrink-0',
          )}
          title={`Reading ${current === undefined ? (scope?.branch ?? 'the project checkout') : `#${current}`}: choose the project checkout or a branch’s worktree`}
          type="button"
        >
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          {current === undefined ? (
            // On a phone the file name needs the room; the sheet and this button's title name the branch.
            !compact && (
              <span className="min-w-0 truncate text-foreground/90">{scope?.branch ?? '…'}</span>
            )
          ) : (
            <>
              <span className="shrink-0 text-foreground/90">#{current}</span>
              {!compact && scope?.title && (
                <span className="min-w-0 max-w-56 truncate font-sans text-[12.5px] text-muted-foreground">
                  {scope.title}
                </span>
              )}
            </>
          )}
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(30rem,calc(100vw-1rem))] p-0"
        // On a phone the list is for tapping; a keyboard would cover it.
        onOpenAutoFocus={(event) => {
          if (compact) event.preventDefault()
        }}
      >
        <Command shouldFilter={false}>
          {(scopes?.length ?? 0) > 6 && (
            <CommandInput
              className="font-mono text-[12.5px]"
              onValueChange={setQuery}
              placeholder="#id, branch or title"
              value={query}
            />
          )}
          <CommandList className="max-h-[60vh]">
            {!scopes && (
              <p className="px-3 py-3 font-mono text-[11.5px] text-muted-foreground">loading…</p>
            )}
            {shown.length > 0 && (
              <CommandGroup>
                {shown.map((item) => (
                  <CommandItem
                    className="gap-2 py-1.5 pointer-coarse:py-2.5"
                    key={item.conversation ?? 'project'}
                    onSelect={() => choose(item.conversation)}
                    value={String(item.conversation ?? 'project')}
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[12.5px]',
                        item.conversation === current && 'text-brand',
                      )}
                    >
                      {item.conversation === undefined ? (
                        'Project checkout'
                      ) : (
                        <>
                          <span className="font-mono text-[12px]">#{item.conversation}</span>{' '}
                          {item.title ?? 'Untitled'}
                        </>
                      )}
                    </span>
                    <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                      {item.branch}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
