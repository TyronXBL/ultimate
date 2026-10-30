import { cn } from 'cn'
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleSlashIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { defineWebExtension, Fold } from '@/sdk'
import { useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { CiResult } from './refs.ts'

const tones = {
  success: ['border-l-success/70', 'text-success', CheckIcon, 'CI passed'],
  failure: ['border-l-error/70', 'text-error', XIcon, 'CI failed'],
  cancelled: ['border-l-warning/70', 'text-warning', CircleSlashIcon, 'CI cancelled'],
  refused: ['border-l-error/70', 'text-error', XIcon, 'CI refused'],
  'no-run': ['border-l-warning/70', 'text-warning', TriangleAlertIcon, 'CI did not start'],
  timeout: ['border-l-warning/70', 'text-warning', TriangleAlertIcon, 'CI timed out'],
  unreachable: ['border-l-warning/70', 'text-warning', TriangleAlertIcon, 'CI unreachable'],
} as const

const duration = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`

/** One CI run's outcome as a card that folds to one line: outcome, commit, duration. */
function CiResultCard({ entry }: { entry: EntryRecord }) {
  const result = entry.data as CiResult
  const { switchConversation } = useUltimate()
  const [border, color, Icon, label] = tones[result.conclusion]
  const sha = result.sha.slice(0, 7)
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <Icon className={cn('size-3 shrink-0', color)} />
          <span className={cn('shrink-0', color)}>{label}</span>
          <span className="shrink-0">· {sha}</span>
          {result.seconds !== undefined && (
            <span className="shrink-0">· {duration(result.seconds)}</span>
          )}
          {result.failures.length > 0 && (
            <span className="min-w-0 truncate">· {result.failures.length} failing</span>
          )}
        </>
      }
    >
      <section
        className={cn(
          'min-w-0 rounded-md border border-l-2 border-border bg-muted/20 font-mono text-[12px]',
          border,
        )}
        data-ci={result.conclusion}
      >
        <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <Icon className={cn('size-3.5 shrink-0', color)} />
          <span className={cn('shrink-0', color)}>{label}</span>
          <span className="shrink-0 text-muted-foreground">{sha}</span>
          {result.seconds !== undefined && (
            <span className="shrink-0 text-muted-foreground">{duration(result.seconds)}</span>
          )}
          <span className="flex-1" />
          {result.url && (
            <a
              className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              href={result.url}
              rel="noreferrer"
              target="_blank"
            >
              open run
              <ArrowUpRightIcon className="size-2.5 opacity-60" />
            </a>
          )}
        </header>
        <div className="space-y-2 px-3 py-2.5 pl-8.5">
          {result.reason && (
            <p className="font-sans text-[12.5px] break-words text-muted-foreground">
              {result.reason}
            </p>
          )}
          {result.failures.length > 0 && (
            <ul className="space-y-1">
              {result.failures.map((failure) => (
                <li className="min-w-0" key={`${failure.title}\n${failure.message}`}>
                  <div className="flex items-baseline gap-1.5 text-foreground/90">
                    <XIcon className="size-3 shrink-0 translate-y-0.5 text-error" />
                    <span className="min-w-0 break-words">{failure.title}</span>
                  </div>
                  <p className="pl-4.5 break-words text-muted-foreground">{failure.message}</p>
                  {failure.earlier && (
                    <p className="pl-4.5 text-muted-foreground">
                      also failed in {failure.earlier.landings} earlier landings{' '}
                      {failure.earlier.branches.map((id, index) => (
                        <button
                          className="hover:text-foreground hover:underline"
                          key={id}
                          onClick={() => switchConversation(id)}
                        >
                          {index ? ' ' : ''}#{id}
                        </button>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.jobs.length > 0 && (
            <ul className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-0.5 text-muted-foreground">
              {result.jobs.map((job) => (
                <li className="contents" key={job.name}>
                  {job.conclusion === 'success' ? (
                    <CheckIcon className="size-3 translate-y-0.5 text-success" />
                  ) : job.conclusion === 'skipped' ? (
                    <CircleSlashIcon className="size-3 translate-y-0.5" />
                  ) : (
                    <XIcon className="size-3 translate-y-0.5 text-error" />
                  )}
                  <span className="min-w-0 truncate">{job.name}</span>
                  <span className="text-right tabular-nums">
                    {job.seconds === undefined ? '' : duration(job.seconds)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </Fold>
  )
}

export default defineWebExtension({
  entries: { 'ci.result': CiResultCard },
})
