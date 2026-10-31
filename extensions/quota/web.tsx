import { GaugeIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, defineWebExtension, formatAgo, useAction, useNow } from '@/sdk'
import { StateAction } from './refs.ts'
import type { QuotaProvider, QuotaWindow } from './refs.ts'

/** From this share on a limit is close; at 100 its pool is blocked until it resets. */
const NEAR = 70

const tone = (used: number) =>
  used >= 100 ? 'text-error' : used >= NEAR ? 'text-warning' : 'text-muted-foreground'

/** The provider's share, rounded down so 99.96 never reads as a full limit. */
const percent = (used: number) => {
  const shown = Math.floor(used * 10) / 10
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)}%`
}

/** `in 42m`, `in 4h 12m`, `in 3d 4h`. */
function until(at: number, now: number) {
  const minutes = Math.ceil((at - now) / 60000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

const absolute = (at: number) =>
  new Date(at).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })

/** The fullest limit across every login, with whose it is. */
function worst(providers: QuotaProvider[]) {
  let top: { provider: QuotaProvider; window: QuotaWindow } | undefined
  for (const provider of providers)
    for (const window of provider.windows)
      if (!top || window.used > top.window.used) top = { provider, window }
  return top
}

function Row({ window, now }: { window: QuotaWindow; now: number }) {
  const blocked = window.used >= 100
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_5rem_3.25rem_5.5rem] items-center gap-x-2 py-0.5">
      <span className="truncate text-foreground/85" title={window.label}>
        {window.label}
      </span>
      <span
        className={cn('relative h-1.5 overflow-hidden rounded-full bg-muted', tone(window.used))}
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full bg-current',
            window.used < NEAR && 'opacity-50',
          )}
          style={{ width: `${Math.min(100, window.used)}%` }}
        />
      </span>
      <span className={cn('text-right tabular-nums', window.used >= NEAR && tone(window.used))}>
        {percent(window.used)}
      </span>
      <span
        className={cn('text-right tabular-nums', blocked ? 'text-error' : 'text-muted-foreground')}
        title={window.resetsAt === undefined ? undefined : `Resets ${absolute(window.resetsAt)}`}
      >
        {window.resetsAt === undefined ? '' : until(window.resetsAt, now)}
      </span>
    </li>
  )
}

function Section({ provider, now }: { provider: QuotaProvider; now: number }) {
  const groups = new Map<string | undefined, QuotaWindow[]>()
  for (const window of provider.windows)
    groups.set(window.group, [...(groups.get(window.group) ?? []), window])
  return (
    <section className="px-3 py-2" data-quota-provider={provider.provider}>
      <header className="flex items-baseline gap-2">
        <span className="font-medium text-foreground">{provider.name}</span>
        {provider.plan && <span className="text-muted-foreground">{provider.plan}</span>}
        {provider.at !== undefined && !provider.error && (
          <span
            className="ml-auto text-[10.5px] text-muted-foreground/70"
            title={`Read ${absolute(provider.at)}`}
          >
            {formatAgo(provider.at, now, { ago: true })}
          </span>
        )}
      </header>
      {provider.error && (
        <div className="mt-0.5 text-error">
          Couldn’t read: {provider.error}
          {provider.at !== undefined && provider.windows.length > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · shown from {formatAgo(provider.at, now, { ago: true })}
            </span>
          )}
        </div>
      )}
      {[...groups].map(([group, windows]) => (
        <div className={cn(group && 'mt-1.5')} key={group ?? ''}>
          {group && <div className="text-[10.5px] text-muted-foreground">{group}</div>}
          <ul className="mt-0.5">
            {windows.map((window) => (
              <Row key={window.label} now={now} window={window} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

/**
 * The status-line chip: how full the subscription logins' usage limits are. Quiet while every limit is under 70 %;
 * amber with the fullest share above it, red once a limit is used up. The popover lists every limit with its reset.
 */
function Chip() {
  const { data, refetch } = useAction(
    StateAction,
    {},
    // A failed poll keeps the last state; the next one asks again.
    { onError: () => {} },
  )
  const now = useNow(60_000)
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [now, refetch])
  const readFresh = (open: boolean) => {
    if (!open) return
    api
      .action(StateAction, { fresh: true })
      .then(() => refetch())
      // The last numbers stay; the minute poll asks again.
      .catch((error: unknown) => console.warn('Quota', error))
  }
  const providers = data?.providers ?? []
  if (!providers.length) return null
  const top = worst(providers)
  const used = top?.window.used ?? 0
  const failed = providers.some((provider) => provider.error)
  const blocked = providers.flatMap((provider) => provider.windows).filter((w) => w.used >= 100)
  return (
    <Popover onOpenChange={readFresh}>
      <PopoverTrigger asChild>
        <button
          aria-label="Subscription limits"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            used >= NEAR && tone(used),
          )}
          data-quota={used >= 100 ? 'blocked' : used >= NEAR ? 'near' : 'ok'}
          type="button"
        >
          <GaugeIcon className={cn('size-3', failed && used < NEAR && 'text-error')} />
          {used >= NEAR && top ? (
            <>
              <span className="max-md:hidden">{top.provider.name}</span>
              <span className="tabular-nums">{percent(used)}</span>
              {blocked.length > 1 && <span className="max-md:hidden">· {blocked.length} full</span>}
            </>
          ) : (
            <span className="max-md:hidden">limits</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[24rem] max-w-[calc(100vw-1rem)] p-0 font-mono text-[11.5px] leading-[1.5]"
        side="top"
      >
        <div className="divide-y divide-border/70">
          {providers.map((provider) => (
            <Section key={provider.provider} now={now} provider={provider} />
          ))}
        </div>
        <div className="border-t border-border/70 px-3 py-1.5 text-[10.5px] text-muted-foreground/80">
          A full limit blocks its models until it resets.
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  // The chip stays on a phone's line: a full limit is what stops a run.
  slots: { 'statusline.right': [{ component: Chip, order: -2, phone: true }] },
})
