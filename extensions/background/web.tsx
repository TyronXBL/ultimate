import { cn } from 'cn'
import { CheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { Card, defineWebExtension, Fold } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { BackgroundResult } from './refs.ts'

const labels = {
  finished: 'Command finished',
  timeout: 'Command timed out',
  lost: 'Command lost',
  'not-started': 'Command not started',
  stopped: 'Command stopped by the heavy-work queue',
} as const
const mib = (value: number) => (value < 1024 ? `${value} MiB` : `${(value / 1024).toFixed(1)} GiB`)
function BackgroundResultCard({ entry }: { entry: EntryRecord }) {
  const result = entry.data as BackgroundResult
  const failed = result.outcome !== 'finished' || result.exitCode !== 0
  const Icon = failed ? (result.outcome === 'finished' ? XIcon : TriangleAlertIcon) : CheckIcon
  const color = failed ? 'text-error' : 'text-success'
  const label = result.usage?.oomKilled ? 'Command hit its memory limit' : labels[result.outcome]
  const usage =
    result.usage && ` · peak ${mib(result.usage.peakMiB)} · CPU ${result.usage.cpuSeconds}s`
  const meta =
    result.outcome === 'not-started'
      ? `waited ${result.seconds}s`
      : `${result.queued ? `queued ${result.queued}s · ` : ''}exit ${result.exitCode ?? 'unknown'} · ${result.seconds}s${usage ?? ''}`
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <Icon className={cn('size-3 shrink-0', color)} />
          <span className={color}>{label}</span>
          <span>· {meta}</span>
        </>
      }
    >
      <Card
        className={cn(
          'font-mono text-[12px]',
          failed ? 'border-l-error/70' : 'border-l-success/70',
        )}
      >
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Icon className={cn('size-3.5', color)} />
          <span className={color}>{label}</span>
          <span className="text-muted-foreground">{meta}</span>
        </header>
        <div className="space-y-2 px-3 py-2.5">
          <p className="break-words text-foreground">{result.command}</p>
          <p className="break-all text-muted-foreground">
            {result.cwd}
            {result.log && ` · ${result.log}`}
          </p>
          {result.note && <p className="break-words text-warning">{result.note}</p>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {result.tail || '(no output)'}
          </pre>
        </div>
      </Card>
    </Fold>
  )
}
export default defineWebExtension({ entries: { 'background.result': BackgroundResultCard } })
