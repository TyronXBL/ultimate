import { CpuIcon, HourglassIcon } from 'lucide-react'
import { Card, defineWebExtension, formatDuration, useDocOf, useNow, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { ModelOwnerDoc } from '../models/ui.tsx'
import type { BackupNotice, BackupReturned, BackupSwitch, BackupWait } from './refs.ts'

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** A conversation whose model answered with a limit now runs on a backup model. */
function Switched({ entry }: { entry: EntryRecord }) {
  const { from, to, reason, error, cooldown } = entry.data as BackupSwitch
  const { runCommand } = useUltimate()
  return (
    <section
      className="min-w-0 rounded-md border border-border border-l-2 border-l-warning/60 bg-muted/20"
      data-backup-switch
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CpuIcon className="size-3.5 text-warning" />
        <span>model switched</span>
        <span className="ml-auto truncate">{reason}</span>
      </header>
      <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p className="font-mono text-[12px]">
          <span className="text-muted-foreground line-through">{from}</span>
          {' → '}
          <span className="text-foreground">{to}</span>
        </p>
        <p className="text-muted-foreground">
          {from.split('/')[0]} answered with a {reason} error, so this conversation runs on {to} and
          returns to {from} at its first run {cooldown} minutes from now.{' '}
          <button
            className="cursor-pointer text-foreground hover:underline"
            onClick={() => runCommand('model.pick')}
            type="button"
          >
            Pick another
          </button>
          .
        </p>
        {error && (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70" title={error}>
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * No backup model could take a limit, so the conversation is back on its primary and continues by itself once the wait
 * is over. While it waits, the footer reads the live wait from the model owner: the next try, and which one it is.
 */
function Waiting({ entry }: { entry: EntryRecord }) {
  const data = (entry.data ?? {}) as Partial<BackupWait>
  const owner = useDocOf(entry.conversationId, ModelOwnerDoc)
  const found = owner?.by === 'login-wait' ? owner.under : owner
  const wait = found?.by === 'limit-wait' && found.since === data.since ? found : undefined
  const now = useNow(1000, !!wait)
  const { runCommand } = useUltimate()
  if (!data.primary || !data.from || data.until === undefined) return null
  const { from, primary, reason, error, skipped = [] } = data
  return (
    <Card className="border-l-warning/60" data-backup-wait>
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <HourglassIcon className="size-3.5 text-warning" />
        <span>waiting for its model</span>
        <span className="ml-auto truncate">{reason}</span>
      </header>
      <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p className="text-muted-foreground">
          {from === primary ? primary : from} answered with a {reason} error and no backup model
          could take it, so this conversation is back on{' '}
          <span className="text-foreground">{primary}</span> and continues by itself once the wait
          is over.
        </p>
        {skipped.length > 0 && (
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {skipped.map(({ model, why }) => (
              <li className="flex min-w-0 gap-2" key={model}>
                <span className="truncate text-muted-foreground/70 line-through">{model}</span>
                <span className="shrink-0">{why}</span>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="truncate font-mono text-[11px] text-muted-foreground/70" title={error}>
            {error}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {wait ? (
          <span className="text-warning">
            next try {clock(wait.until)} · in {formatDuration(Math.max(0, wait.until - now))}
            {wait.attempt > 1 && ` · try ${wait.attempt}`}
          </span>
        ) : (
          <span>wait over</span>
        )}
        <button
          className="cursor-pointer text-foreground hover:underline"
          onClick={() => runCommand('model.pick')}
          type="button"
        >
          Pick another
        </button>
      </footer>
    </Card>
  )
}

/** The same switch or wait, one line in @ultimate's transcript. */
function Notice({ entry }: { entry: EntryRecord }) {
  const data = (entry.data ?? {}) as Partial<BackupNotice>
  const { switchConversation } = useUltimate()
  if (data.conversation === undefined || !data.from || !data.to) return null
  const conversation = data.conversation
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-warning/25 after:h-px after:flex-1 after:bg-warning/25"
      data-backup-notice
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <CpuIcon className="size-3 shrink-0 text-warning" />
        <button
          className="min-w-0 cursor-pointer text-warning hover:underline"
          onClick={() => switchConversation(conversation)}
          type="button"
        >
          <ConversationRef id={conversation} />
        </button>
        <span className="truncate">
          {data.until === undefined
            ? `· ${data.from} → ${data.to} · ${data.reason}`
            : `· ${data.reason} on ${data.from} · waits for ${data.to} until ${clock(data.until)}`}
        </span>
      </span>
    </div>
  )
}

/** Where a conversation went back to its primary: one quiet divider. */
function Returned({ entry }: { entry: EntryRecord }) {
  const data = (entry.data ?? {}) as Partial<BackupReturned>
  if (!data.from || !data.to) return null
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-backup-return
    >
      <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
        <CpuIcon className="size-3 shrink-0" />
        <span className="truncate">
          {data.from} → {data.to} · back to its primary
        </span>
      </span>
    </div>
  )
}

export default defineWebExtension({
  entries: {
    'backup.switch': Switched,
    'backup.wait': Waiting,
    'backup.notice': Notice,
    'backup.return': Returned,
  },
})
