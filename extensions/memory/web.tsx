import { MemoryStickIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, defineWebExtension, useAction, useNow } from '@/sdk'
import { StateAction } from './refs.ts'
import type { MemoryState } from './refs.ts'

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GB`

/** Where a group runs: the conversation of a worktree, else the folder's name. */
function where(cwd?: string) {
  if (!cwd) return ''
  const worktree = /\/worktrees\/(\d+)(\/|$)/.exec(cwd)?.[1]
  return worktree ? `#${worktree}` : cwd.split('/').pop() || cwd
}

function Users({ state }: { state: MemoryState }) {
  if (!state.users.length) return null
  return (
    <ul className="px-3 py-2">
      {state.users.map((user) => (
        <li
          className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-baseline gap-x-2 py-0.5"
          key={user.pgid}
          title={`${user.command}\n${user.cwd ?? ''}\nprocess group ${user.pgid} · ${user.processes} processes`}
        >
          <span className="truncate text-foreground/85">
            {user.name ? `${user.name} · ` : ''}
            {user.command}
          </span>
          <span className="text-muted-foreground">{where(user.cwd)}</span>
          <span className="text-right tabular-nums">{user.rssMiB} MiB</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The status-line chip: shown only while available RAM is within 1 GiB of the floor (`memory.minAvailableMiB`), in
 * amber. The popover lists the largest process groups this Ultimate started, so the user sees what to stop.
 */
function Chip() {
  const { data: state, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one asks again.
    { onError: () => {} },
  )
  const now = useNow(15_000)
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [now, refetch])
  if (!state?.near || state.floor === undefined || state.available === undefined) return null
  const below = state.available < state.floor
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Available RAM"
          className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-warning transition-colors hover:bg-accent data-[state=open]:bg-accent"
          data-memory={below ? 'below' : 'near'}
          type="button"
        >
          <MemoryStickIcon className="size-3" />
          <span className="tabular-nums">{gib(state.available)}</span>
          <span className="max-md:hidden">free</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono text-[11.5px] leading-[1.5]"
        side="top"
      >
        <header className="flex items-baseline gap-2 border-b border-border/70 px-3 py-2">
          <span className="font-medium text-foreground">Available RAM</span>
          <span className={cn('tabular-nums', below ? 'text-error' : 'text-warning')}>
            {state.available} MiB
          </span>
          <span className="ml-auto text-muted-foreground">floor {state.floor} MiB</span>
        </header>
        {state.cgroup && (
          <div
            className="flex items-baseline gap-2 border-b border-border/70 px-3 py-1.5"
            title="memory.current of the cgroup Ultimate runs in; at memory.high the kernel throttles it, at memory.max it stops processes"
          >
            <span className="text-foreground/85">Ultimate&apos;s cgroup</span>
            <span className="tabular-nums">{state.cgroup.current} MiB</span>
            <span className="ml-auto text-muted-foreground tabular-nums">
              {[
                state.cgroup.high !== undefined && `high ${state.cgroup.high}`,
                state.cgroup.max !== undefined && `max ${state.cgroup.max}`,
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              MiB
            </span>
          </div>
        )}
        <Users state={state} />
        <div className="border-t border-border/70 px-3 py-1.5 text-[10.5px] text-muted-foreground/80">
          Jobs that would go below the floor wait (background commands, landings) or are refused
          (previews, heavy bash commands).
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2, phone: true }] },
})
