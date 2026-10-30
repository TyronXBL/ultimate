import { cn } from 'cn'
import { CheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { Card, defineWebExtension, Fold } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { BackgroundResult } from './refs.ts'

const labels = {
  finished: 'Command finished',
  timeout: 'Command timed out',
  lost: 'Command lost',
} as const
function BackgroundResultCard({ entry }: { entry: EntryRecord }) {
  const result = entry.data as BackgroundResult
  const failed = result.outcome !== 'finished' || result.exitCode !== 0
  const Icon = failed
    ? result.outcome === 'timeout' || result.outcome === 'lost'
      ? TriangleAlertIcon
      : XIcon
    : CheckIcon
  const color = failed ? 'text-error' : 'text-success'
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <Icon className={cn('size-3 shrink-0', color)} />
          <span className={color}>{labels[result.outcome]}</span>
          <span>
            · exit {result.exitCode ?? 'unknown'} · {result.seconds}s
          </span>
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
          <span className={color}>{labels[result.outcome]}</span>
          <span className="text-muted-foreground">
            exit {result.exitCode ?? 'unknown'} · {result.seconds}s
          </span>
        </header>
        <div className="space-y-2 px-3 py-2.5">
          <p className="break-words text-foreground">{result.command}</p>
          <p className="break-all text-muted-foreground">
            {result.cwd} · {result.log}
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {result.tail || '(no output)'}
          </pre>
        </div>
      </Card>
    </Fold>
  )
}
export default defineWebExtension({ entries: { 'background.result': BackgroundResultCard } })
