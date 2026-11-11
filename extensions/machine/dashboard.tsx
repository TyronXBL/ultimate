/**
 * The Machine tab's content for one `MachineState`: what needs attention, the heavy-work queue, the last hour of
 * resources, and who uses the machine now. Pure rendering; `web.tsx` polls the state and hands it in.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn, formatDuration, formatTime, plural, useConversations, useUltimate } from '@/sdk'
import { Chart, HOUR_MS, Meter, sampleAt } from './charts.tsx'
import type {
  MachineState,
  Owner,
  OwnerKind,
  Pressure,
  QueueJob,
  Sample,
  WaitReason,
} from './refs.ts'

/** 512 MB, 3.4 GB. */
export const mem = (mib: number) =>
  mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`
const cores = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1))

/** Work that does not wait its turn: a conversation's commands outside the queue, an automation's script. */
const outsideKinds: ReadonlySet<OwnerKind> = new Set(['work', 'automation'])
/** CPU at which an owner outside the queue is worth flagging, in cores. */
const OUTSIDE_CORES = 0.5
const isOutside = (owner: Owner) => outsideKinds.has(owner.kind) && owner.cpu >= OUTSIDE_CORES

const card = 'rounded-lg border border-border/70 bg-card/40'
const head =
  'flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[11px] text-muted-foreground'

/** Worst first: below the floor stops jobs, outside work is what nobody sees. */
const severity: Record<Pressure['kind'], number> = { ram: 0, outside: 1, load: 2, swap: 3, temp: 4 }

/** A pressure in words, and whether it is past a limit (red) rather than near one (amber). */
export function describePressure(pressure: Pressure): { text: string; error: boolean } {
  switch (pressure.kind) {
    case 'ram':
      return {
        text: `${pressure.below ? 'RAM below the floor' : 'RAM near the floor'}: ${mem(pressure.availableMiB)} free, floor ${mem(pressure.floorMiB)}`,
        error: pressure.below,
      }
    case 'outside':
      return {
        text: `Work outside the queue uses ${cores(pressure.cores)} cores`,
        error: false,
      }
    case 'load':
      return {
        text: `Load ${pressure.load.toFixed(1)} on ${pressure.cores} cores`,
        error: false,
      }
    case 'swap':
      return {
        text: `Swap ${mem(pressure.usedMiB)} of ${mem(pressure.totalMiB)} used`,
        error: false,
      }
    default:
      return {
        text: `${pressure.name} ${Math.round((pressure.usedMiB / pressure.sizeMiB) * 100)}% full`,
        error: false,
      }
  }
}

/** Opens a conversation of this project on the Agent surface; other projects' conversations show as text. */
function useWho(project: string) {
  const conversations = useConversations()
  const { showSurface, switchConversation } = useUltimate()
  return (where: { project?: string; conversation?: number }, fallback?: string): ReactNode => {
    const { conversation } = where
    if (conversation !== undefined && where.project === project) {
      const title = conversations.find((item) => item.id === conversation)?.title
      return (
        <button
          className="max-w-full cursor-pointer truncate rounded-sm text-left text-foreground/80 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            showSurface('agent')
            switchConversation(conversation)
          }}
          title={`Open #${conversation}`}
          type="button"
        >
          {title ? `${title} #${conversation}` : `#${conversation}`}
        </button>
      )
    }
    if (conversation !== undefined && where.project) return `#${conversation} in ${where.project}`
    return where.project ?? fallback ?? ''
  }
}

/** The dashboard's head: whether the machine is fine, else what needs attention, worst first. */
function Status({ state, latest }: { state: MachineState; latest?: Sample }) {
  const found = state.pressure.toSorted((a, b) => severity[a.kind] - severity[b.kind])
  const running = state.queue.filter((job) => job.state !== 'waiting').length
  const facts = [
    latest && `load ${latest.load.toFixed(1)} / ${state.cores} cores`,
    latest && `${mem(latest.availableMiB)} free`,
    `${running} running · ${state.queue.length - running} waiting`,
  ].filter(Boolean)
  return (
    <div className={cn(card, 'flex flex-col gap-1 px-3 py-2.5')} data-machine-status>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="section-label">Machine</span>
        {found.length === 0 ? (
          <span className="text-[13px] text-foreground/90">Fine: nothing needs attention</span>
        ) : (
          <span className="text-[13px] font-medium text-warning">
            {plural(found.length, 'thing')} need{found.length === 1 ? 's' : ''} attention
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
          {facts.join(' · ')}
        </span>
      </div>
      {found.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px]">
          {found.map((pressure, index) => {
            const { text, error } = describePressure(pressure)
            return (
              <li
                className={cn('flex items-baseline gap-2', error ? 'text-error' : 'text-warning')}
                data-pressure={pressure.kind}
                key={index}
              >
                <span
                  className={cn(
                    'inline-block size-1.5 shrink-0 translate-y-[-1px] rounded-full',
                    error ? 'bg-error' : 'bg-warning',
                  )}
                />
                {text}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Why the first job in line waits, in words; amber when the machine itself holds it back. A job behind another needs
 * no words: the job ahead is the row above it, and its tooltip names it.
 */
function reasonOf(reason: WaitReason, now: number): { text: string; held: boolean } | undefined {
  switch (reason.kind) {
    case 'behind':
      return undefined
    case 'ram':
      return {
        text: `RAM short: ${mem(reason.availableMiB)} free${reason.reservedMiB ? ` (${mem(reason.reservedMiB)} reserved by jobs just started)` : ''}, needs ${reason.needMiB ? `${mem(reason.needMiB)} above` : 'more than'} the ${mem(reason.floorMiB)} floor`,
        held: true,
      }
    case 'load':
      return {
        text: `load ${reason.load.toFixed(1)} at or above ${reason.cores} cores`,
        held: true,
      }
    case 'next':
      return { text: 'starts at the next look, within 5 s', held: false }
    default:
      return {
        text: `queue settling: starts after running jobs report back, in ${formatDuration(Math.max(0, reason.until - now))}`,
        held: true,
      }
  }
}

function Queue({ state, who }: { state: MachineState; who: ReturnType<typeof useWho> }) {
  const running = state.queue.filter((job) => job.state !== 'waiting')
  const waiting = state.queue.length - running.length
  return (
    <section className={card} data-machine-queue>
      <div className={head}>
        <span className="section-label">Queue</span>
        <span className="tabular-nums">
          {running.length} running · {waiting} waiting
        </span>
        <span className="ml-auto max-md:hidden">
          heavy work from every project, one turn at a time
        </span>
      </div>
      {state.queue.length === 0 ? (
        <p className="px-3 py-4 font-mono text-[11px] text-muted-foreground">
          Queue empty: the next heavy job starts at once
          {state.pressure.length > 0 && ', unless what needs attention above holds it back'}
        </p>
      ) : (
        <ol className="flex flex-col py-1">
          {state.queue.map((job) => (
            <JobRow job={job} key={job.id} now={state.now} who={who} />
          ))}
        </ol>
      )}
    </section>
  )
}

function JobRow({ job, now, who }: { job: QueueJob; now: number; who: ReturnType<typeof useWho> }) {
  const waiting = job.state === 'waiting'
  const reason = waiting ? reasonOf(job.reason, now) : undefined
  return (
    <li
      className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2 px-3 py-1 font-mono text-[11px]"
      data-job={job.state}
      title={
        job.state === 'waiting' && job.reason.kind === 'behind'
          ? `${job.label}\nbehind ${job.reason.label} (${job.reason.from})`
          : job.label
      }
    >
      <span className="flex h-[18px] items-center text-muted-foreground tabular-nums">
        {job.state === 'running' && (
          <span className="inline-block size-1.5 rounded-full bg-brand" title="running" />
        )}
        {job.state === 'measuring' && (
          <span
            className="inline-block size-1.5 rounded-full border border-brand"
            title="measuring"
          />
        )}
        {waiting && job.position}
      </span>
      <span className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-3">
        <span className="truncate text-[12px] text-foreground md:w-2/5 md:shrink-0">
          {job.label}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">{who(job, job.from)}</span>
      </span>
      <span className="text-right text-muted-foreground tabular-nums">
        {waiting ? (
          <>waiting {formatDuration(Math.max(0, now - job.at))}</>
        ) : (
          <>
            <span className={cn(job.state === 'running' ? 'text-foreground/80' : '')}>
              {job.state} {formatDuration(Math.max(0, now - job.since))}
            </span>
            {(job.cpu !== undefined || job.rssMiB !== undefined) && (
              <span className="block">
                {job.cpu !== undefined && `${cores(job.cpu)} cores`}
                {job.cpu !== undefined && job.rssMiB !== undefined && ' · '}
                {job.rssMiB !== undefined && mem(job.rssMiB)}
              </span>
            )}
          </>
        )}
      </span>
      {job.state === 'measuring' && job.until !== undefined && (
        <span className="col-start-2 col-end-4 text-muted-foreground/80">
          on probation: an unknown command, measured until {formatTime(job.until, true)}
        </span>
      )}
      {reason && (
        <span
          className={cn(
            'col-start-2 col-end-4',
            reason.held ? 'text-warning' : 'text-muted-foreground/80',
          )}
          data-reason={job.state === 'waiting' ? job.reason.kind : undefined}
        >
          {reason.text}
        </span>
      )}
      {/* A per-row "run next" control would go here, at the row's right, for waiting jobs. */}
    </li>
  )
}

/** CPU by who uses it, the stacked bands of the CPU chart: work outside the queue on top, in amber. */
const bands: { name: string; kinds: OwnerKind[]; className: string }[] = [
  { name: 'system', kinds: ['system'], className: 'text-muted-foreground/30' },
  {
    name: 'Ultimate',
    kinds: ['host', 'preview', 'browser'],
    className: 'text-muted-foreground/70',
  },
  { name: 'queue', kinds: ['job', 'lander'], className: 'text-foreground/80' },
  { name: 'outside the queue', kinds: ['work', 'automation'], className: 'text-warning' },
]
const bandCpu = (sample: Sample, kinds: OwnerKind[]) =>
  kinds.reduce((sum, kind) => sum + (sample.cpu[kind] ?? 0), 0)

function Resources({ state, samples }: { state: MachineState; samples: Sample[] }) {
  const [hover, setHover] = useState<number>()
  const hovered = hover === undefined ? undefined : sampleAt(samples, hover)
  const shown = hovered ?? samples.at(-1)
  const now = state.now
  const charts = { samples, now, hover: hovered?.at, onHover: setHover }
  const loadMax = Math.max(state.cores * 1.25, ...samples.map((sample) => sample.load))
  const cpuMax = Math.max(
    state.cores,
    ...samples.map((sample) => bands.reduce((sum, band) => sum + bandCpu(sample, band.kinds), 0)),
  )
  const below = shown && state.floorMiB !== undefined && shown.availableMiB < state.floorMiB
  const near = shown && state.floorMiB !== undefined && shown.availableMiB < state.floorMiB + 1024
  return (
    <section className={card} data-machine-resources>
      <div className={head}>
        <span className="section-label">Last hour</span>
        <span className="tabular-nums">
          {hovered ? `at ${formatTime(hovered.at, true)}` : 'now'}
        </span>
        <span className="ml-auto tabular-nums">
          {samples[0] ? `since ${formatTime(Math.max(samples[0].at, now - HOUR_MS))}` : ''}
        </span>
      </div>
      {!shown ? (
        <p className="px-3 py-4 font-mono text-[11px] text-muted-foreground">
          No samples yet: the first arrives within seconds
        </p>
      ) : (
        <div className="grid gap-x-6 gap-y-4 px-3 py-3 md:grid-cols-2">
          <Chart
            {...charts}
            marks={[{ value: state.cores, className: 'text-muted-foreground/70' }]}
            max={loadMax}
            reading={
              <span className={cn(shown.load >= state.cores && 'text-warning')}>
                {shown.load.toFixed(1)}
                <span className="text-muted-foreground"> / {state.cores} cores</span>
              </span>
            }
            series={[
              {
                value: (sample) => sample.load,
                className: 'text-foreground/70',
                fill: true,
              },
            ]}
            title="Load"
          />
          <Chart
            {...charts}
            max={cpuMax}
            marks={[{ value: state.cores, className: 'text-muted-foreground/70' }]}
            reading={
              <span className="flex flex-wrap justify-end gap-x-2">
                {bands.toReversed().map((band) => {
                  const value = bandCpu(shown, band.kinds)
                  return (
                    <span className="flex items-baseline gap-1" key={band.name}>
                      <span
                        className={cn(
                          'inline-block size-1.5 translate-y-[-1px] rounded-full bg-current',
                          band.className,
                        )}
                      />
                      <span
                        className={cn(
                          band.name === 'outside the queue' && value >= 1 && 'text-warning',
                        )}
                      >
                        {band.name} {cores(value)}
                      </span>
                    </span>
                  )
                })}
              </span>
            }
            series={bands.map((band) => ({
              value: (sample) => bandCpu(sample, band.kinds),
              className: band.className,
              fill: true,
            }))}
            stacked
            title="CPU"
          />
          <Chart
            {...charts}
            marks={
              state.floorMiB === undefined
                ? []
                : [{ value: state.floorMiB, className: 'text-error/70' }]
            }
            max={state.totalMiB}
            reading={
              <span>
                <span className={cn(below ? 'text-error' : near && 'text-warning')}>
                  {mem(shown.availableMiB)} free
                </span>
                <span className="text-muted-foreground">
                  {' '}
                  of {mem(state.totalMiB)}
                  {state.floorMiB === undefined ? ' · no floor' : ` · floor ${mem(state.floorMiB)}`}
                </span>
              </span>
            }
            series={[
              {
                value: (sample) => sample.availableMiB,
                className: 'text-foreground/70',
                fill: true,
              },
            ]}
            title="Available RAM"
          />
          <Chart
            {...charts}
            max={Math.max(state.swapTotalMiB, 1)}
            reading={
              state.swapTotalMiB === 0 ? (
                <span className="text-muted-foreground">no swap</span>
              ) : (
                <span>
                  <span
                    className={cn(shown.swapUsedMiB >= state.swapTotalMiB * 0.8 && 'text-warning')}
                  >
                    {mem(shown.swapUsedMiB)}
                  </span>
                  <span className="text-muted-foreground"> of {mem(state.swapTotalMiB)}</span>
                </span>
              )
            }
            series={[
              {
                value: (sample) => sample.swapUsedMiB,
                className: 'text-foreground/70',
                fill: true,
              },
            ]}
            title="Swap used"
          />
        </div>
      )}
      {state.temp.length > 0 && (
        <ul className="grid gap-x-6 gap-y-2 border-t border-border/70 px-3 py-2.5 font-mono text-[11px] md:grid-cols-2">
          {state.temp.map((use) => {
            const share = use.sizeMiB ? use.usedMiB / use.sizeMiB : 0
            return (
              <li className="flex min-w-0 flex-col gap-1" key={use.path}>
                <span className="flex items-baseline gap-2">
                  <span className="text-foreground/85">{use.name}</span>
                  <span className="min-w-0 truncate text-muted-foreground/70">
                    {use.path}
                    {use.ram && ' · in RAM'}
                  </span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 tabular-nums',
                      share >= 0.9 ? 'text-warning' : 'text-muted-foreground',
                    )}
                  >
                    {mem(use.usedMiB)} of {mem(use.sizeMiB)}
                  </span>
                </span>
                <Meter className={cn(share >= 0.9 && 'bg-warning')} share={share} />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** An owner kind in the user's words. */
const kindWords: Record<OwnerKind, string> = {
  host: 'Ultimate',
  job: 'queued job',
  lander: 'landing checks',
  work: 'work',
  preview: 'preview',
  browser: 'browser',
  automation: 'automation',
  system: 'system',
}

/**
 * One owner: one line on a desktop (kind, label, where, CPU, memory); on a phone two, the label and its CPU over the
 * kind, where and memory.
 */
function OwnerRow({ owner, who }: { owner: Owner; who: ReturnType<typeof useWho> }) {
  const outside = isOutside(owner)
  const where = who(owner)
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-1 font-mono text-[11px] md:grid-cols-[9rem_minmax(0,2fr)_minmax(0,3fr)_4.5rem_4.5rem]"
      data-owner={owner.kind}
      data-outside={outside || undefined}
      title={`${plural(owner.processes, 'process')} · since ${formatTime(owner.since)}`}
    >
      <span className="order-1 truncate text-[12px] text-foreground/90 md:order-2">
        {owner.label}
      </span>
      <span
        className={cn(
          'order-2 text-right tabular-nums md:order-4',
          outside ? 'text-warning' : 'text-foreground/80',
        )}
      >
        {cores(owner.cpu)} cores
      </span>
      <span className="order-3 flex min-w-0 gap-2 md:contents">
        <span
          className={cn(
            'shrink-0 truncate md:order-1',
            outside ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {outside ? `${kindWords[owner.kind]} outside the queue` : kindWords[owner.kind]}
        </span>
        <span className="min-w-0 truncate text-muted-foreground md:order-3">{where}</span>
      </span>
      <span className="order-4 text-right text-muted-foreground tabular-nums md:order-5">
        {mem(owner.rssMiB)}
      </span>
    </li>
  )
}

/** A long-lived memory holder: what it is, where, how long it has been up, and its memory. */
function HolderRow({
  owner,
  who,
  now,
}: {
  owner: Owner
  who: ReturnType<typeof useWho>
  now: number
}) {
  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto_4.5rem] items-baseline gap-x-3 px-3 py-1 font-mono text-[11px]"
      data-owner={owner.kind}
      title={`${kindWords[owner.kind]} · ${plural(owner.processes, 'process')} · since ${formatTime(owner.since)}`}
    >
      <span className="text-[12px] text-foreground/90">{owner.label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{who(owner)}</span>
      <span className="text-muted-foreground tabular-nums">
        up {formatDuration(Math.max(0, now - owner.since))}
      </span>
      <span className="text-right text-foreground/80 tabular-nums">{mem(owner.rssMiB)}</span>
    </li>
  )
}

function Owners({ state, who }: { state: MachineState; who: ReturnType<typeof useWho> }) {
  const { more } = state
  return (
    <section className={cn(card, 'min-w-0 lg:col-span-2')} data-machine-owners>
      <div className={head}>
        <span className="section-label">Who uses it now</span>
        <span className="ml-auto">by CPU, then memory</span>
      </div>
      {state.owners.length === 0 ? (
        <p className="px-3 py-4 font-mono text-[11px] text-muted-foreground">
          Nothing measured yet
        </p>
      ) : (
        <ul className="flex flex-col py-1">
          {state.owners.map((owner) => (
            <OwnerRow key={owner.key} owner={owner} who={who} />
          ))}
        </ul>
      )}
      {more.owners > 0 && (
        <p className="border-t border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
          {more.owners} more · {cores(more.cpu)} cores · {mem(more.rssMiB)}
        </p>
      )}
    </section>
  )
}

/** Previews and Chromiums: they hold memory for hours, and jobs wait for RAM behind them. */
function Holders({ state, who }: { state: MachineState; who: ReturnType<typeof useWho> }) {
  const holders = state.owners
    .filter((owner) => owner.kind === 'preview' || owner.kind === 'browser')
    .toSorted((a, b) => b.rssMiB - a.rssMiB)
  const total = holders.reduce((sum, owner) => sum + owner.rssMiB, 0)
  return (
    <section className={cn(card, 'min-w-0 self-start')} data-machine-holders>
      <div className={head}>
        <span className="section-label">Held memory</span>
        <span className="ml-auto tabular-nums">{mem(total)}</span>
      </div>
      {holders.length === 0 ? (
        <p className="px-3 py-4 font-mono text-[11px] text-muted-foreground">
          No previews or browsers running
        </p>
      ) : (
        <ul className="flex flex-col py-1">
          {holders.map((owner) => (
            <HolderRow key={owner.key} now={state.now} owner={owner} who={who} />
          ))}
        </ul>
      )}
      <p className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
        Previews and browsers keep their memory until stopped; jobs wait for RAM behind them.
      </p>
    </section>
  )
}

/** The whole tab for `state`, with `samples` the hour of history kept in the browser. */
export function Dashboard({ state, samples }: { state: MachineState; samples: Sample[] }) {
  const who = useWho(state.project)
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 px-3 py-3 md:px-5">
      <Status latest={samples.at(-1)} state={state} />
      <Queue state={state} who={who} />
      <Resources samples={samples} state={state} />
      <div className="grid gap-3 lg:grid-cols-3">
        <Owners state={state} who={who} />
        <Holders state={state} who={who} />
      </div>
    </div>
  )
}
