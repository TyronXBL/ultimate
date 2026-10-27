import { CpuIcon } from 'lucide-react'
import { defineWebExtension, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import type { BackupNotice, BackupReturned, BackupSwitch } from './refs.ts'

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

/** The same switch, one line in @ultimate's transcript. */
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
          · {data.from} → {data.to} · {data.reason}
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
  entries: { 'backup.switch': Switched, 'backup.notice': Notice, 'backup.return': Returned },
})
