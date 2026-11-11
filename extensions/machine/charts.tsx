/** The hour of history as thin hand-drawn SVG charts: lines and stacked areas over time, with a shared hover. */
import type { ReactNode } from 'react'
import { cn } from '@/sdk'
import type { Sample } from './refs.ts'

export const HOUR_MS = 60 * 60_000
/** Samples further apart than this have a gap between them (a host restart): the line breaks there. */
const GAP_MS = 45_000
const W = 600
const H = 64

/** Runs of samples without a gap. */
function segments(samples: Sample[]) {
  const runs: Sample[][] = []
  for (const sample of samples) {
    const run = runs.at(-1)
    const last = run?.at(-1)
    if (run && last && sample.at - last.at <= GAP_MS) run.push(sample)
    else runs.push([sample])
  }
  return runs
}

type Frame = { now: number; max: number }
const xOf = (at: number, { now }: Frame) => ((at - (now - HOUR_MS)) / HOUR_MS) * W
const yOf = (value: number, { max }: Frame) =>
  H - (Math.min(Math.max(value, 0), max) / (max || 1)) * H
const point = (at: number, value: number, frame: Frame) =>
  `${xOf(at, frame).toFixed(1)},${yOf(value, frame).toFixed(1)}`

/** A line through `value` of each sample, broken at gaps. */
function linePath(samples: Sample[], value: (sample: Sample) => number, frame: Frame) {
  return segments(samples)
    .map((run) =>
      run.map((sample, i) => `${i ? 'L' : 'M'}${point(sample.at, value(sample), frame)}`).join(''),
    )
    .join('')
}

/** The area between `low` and `high` of each sample, broken at gaps. */
function bandPath(
  samples: Sample[],
  low: (sample: Sample) => number,
  high: (sample: Sample) => number,
  frame: Frame,
) {
  return segments(samples)
    .map((run) => {
      const top = run.map((sample, i) => `${i ? 'L' : 'M'}${point(sample.at, high(sample), frame)}`)
      const bottom = run.toReversed().map((sample) => `L${point(sample.at, low(sample), frame)}`)
      return `${top.join('')}${bottom.join('')}Z`
    })
    .join('')
}

/** One series: a line, or a band stacked on the series before it. */
export type Series = {
  value: (sample: Sample) => number
  /** A theme text colour (`text-warning`), drawn with `currentColor`. */
  className: string
  /** Fill the area under it (stacked on the series before it when `stacked`). */
  fill?: boolean
}

/** A horizontal reference line: the core count, the RAM floor. */
export type Mark = { value: number; className: string }

/**
 * A chart of the last hour: a caption with the number it shows (the hovered sample's, else now's) and an SVG of its
 * series. `hover` is the time under the pointer, shared by every chart of the dashboard.
 */
export function Chart({
  title,
  reading,
  samples,
  now,
  max,
  series,
  stacked,
  marks = [],
  hover,
  onHover,
}: {
  title: string
  reading: ReactNode
  samples: Sample[]
  now: number
  max: number
  series: Series[]
  stacked?: boolean
  marks?: Mark[]
  hover?: number
  onHover: (at?: number) => void
}) {
  const frame = { now, max }
  const bands: { low: (s: Sample) => number; high: (s: Sample) => number }[] = []
  for (const [index, item] of series.entries()) {
    const below = stacked && index > 0 ? bands[index - 1].high : () => 0
    bands.push({ low: below, high: (sample) => below(sample) + item.value(sample) })
  }
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="flex items-baseline gap-2 font-mono text-[11px]">
        <span className="text-muted-foreground">{title}</span>
        <span className="ml-auto truncate text-right tabular-nums">{reading}</span>
      </figcaption>
      <svg
        aria-label={title}
        className="h-16 w-full touch-pan-y overflow-visible"
        onPointerLeave={() => onHover(undefined)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const at = now - HOUR_MS + ((event.clientX - box.left) / box.width) * HOUR_MS
          onHover(Math.min(at, now))
        }}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
        <line
          className="text-border"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={W}
          y1={H}
          y2={H}
        />
        {series.map((item, index) => (
          <g className={item.className} key={index}>
            {item.fill && (
              <path
                d={bandPath(samples, bands[index].low, bands[index].high, frame)}
                fill="currentColor"
                fillOpacity={stacked ? 0.6 : 0.12}
              />
            )}
            {/* Stacked bands go without lines: the top one's line would trace the total in its colour. */}
            {!stacked && (
              <path
                d={linePath(samples, bands[index].high, frame)}
                fill="none"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        ))}
        {marks.map((mark) => (
          <line
            className={mark.className}
            key={mark.className}
            stroke="currentColor"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            x1={0}
            x2={W}
            y1={yOf(mark.value, frame)}
            y2={yOf(mark.value, frame)}
          />
        ))}
        {hover !== undefined && (
          <line
            className="text-muted-foreground/60"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
            x1={xOf(hover, frame)}
            x2={xOf(hover, frame)}
            y1={0}
            y2={H}
          />
        )}
      </svg>
    </figure>
  )
}

/** The sample nearest to `at`, if one is within a gap of it. */
export function sampleAt(samples: Sample[], at: number) {
  let best: Sample | undefined
  for (const sample of samples)
    if (!best || Math.abs(sample.at - at) < Math.abs(best.at - at)) best = sample
  return best && Math.abs(best.at - at) <= GAP_MS ? best : undefined
}

/** A thin bar for a share of a whole, such as a temp folder's use. */
export function Meter({ share, className }: { share: number; className?: string }) {
  return (
    <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
      <span
        className={cn('block h-full rounded-full bg-muted-foreground/60', className)}
        style={{ width: `${Math.min(Math.max(share, 0), 1) * 100}%` }}
      />
    </span>
  )
}
