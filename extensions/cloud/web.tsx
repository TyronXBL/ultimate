import { CloudIcon, LoaderCircleIcon } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, defineWebExtension, errorMessage, formatAgo, formatBytes } from '@/sdk'
import { JoinDialog, joinDialog } from './join.tsx'
import { BackupAction, StateAction } from './refs.ts'
import { headline } from './run.ts'
import type { CloudState, Run } from './types.ts'

/** One poll shared by every component that reads it, running while any is mounted; a failed poll keeps the last value. */
function poll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  every: (value: T | undefined) => number,
) {
  let value: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const tick = async () => {
    const current = ++generation
    clearTimeout(timer)
    controller?.abort()
    controller = new AbortController()
    try {
      const next = await load(controller.signal)
      if (current !== generation) return
      value = next
      for (const listener of listeners) listener()
    } catch {
      // Aborted, restarting or unreachable: keep what was loaded, and the next poll tries again.
    }
    if (current === generation && listeners.size)
      timer = setTimeout(() => void tick(), every(value))
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      // oxlint-disable-next-line typescript/no-floating-promises -- tick catches load failures, keeps the previous value and retries on the next poll.
      if (listeners.size === 1) void tick()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        generation++
        clearTimeout(timer)
        controller?.abort()
      }
    },
    get: () => value,
    refresh: () => void tick(),
  }
}

const local = poll(
  (signal) => api.action(StateAction, null, { signal }),
  (state) => (state?.status === 'off' ? 30_000 : state?.run.state === 'uploading' ? 1000 : 10_000),
)
const useLocal = () => useSyncExternalStore(local.subscribe, local.get)

const backUp = async (force: boolean) => {
  const done = api.action(BackupAction, force ? { force } : null)
  // The upload's progress shows as soon as the server started it.
  setTimeout(local.refresh, 300)
  await done.finally(local.refresh)
}

const since = (at: number) => formatAgo(at, Date.now(), { ago: true })
const mb = (bytes: number) => {
  const value = bytes / 1024 / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

/** A button that runs `action`, showing its failure under the row. */
function useAct() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const act = (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    action()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  return { busy, error, act }
}

/** The last backup, "Back up now" and the upload while it runs. */
function BackupRow({ state }: { state: CloudState }) {
  const { busy, error, act } = useAct()
  const { lastBackup, run } = state
  const uploading = run.state === 'uploading'
  return (
    <div className="space-y-1 px-3 py-2" data-cloud-backup>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-foreground/90">
            {uploading ? 'Backing up…' : 'Backup'}
          </span>
          <span
            className="block text-[11px] text-muted-foreground tabular-nums"
            title={lastBackup ? new Date(lastBackup.at).toLocaleString() : undefined}
          >
            {run.state === 'uploading' && run.total > 0
              ? `${mb(run.done)} / ${mb(run.total)} MB read · ${mb(run.uploaded)} MB uploaded`
              : lastBackup
                ? `${since(lastBackup.at)} from ${lastBackup.machine} · ${formatBytes(lastBackup.uploaded)} (${formatBytes(lastBackup.bytes)} database)`
                : 'No backup from this machine yet'}
          </span>
        </span>
        <Button
          className="h-6 font-sans text-[12px]"
          disabled={busy || uploading}
          onClick={() => act(() => backUp(false))}
          size="xs"
          title="Upload an encrypted snapshot of this project now"
          variant="outline"
        >
          {uploading ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
          Back up now
        </Button>
      </div>
      {run.state === 'uploading' && (
        <div className="h-0.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-brand/70 transition-[width]"
            style={{
              width: `${run.total ? Math.min(100, (run.done / run.total) * 100) : 0}%`,
            }}
          />
        </div>
      )}
      {error && run.state !== 'conflict' && (
        <p className="font-sans text-[12px] text-error">{error}</p>
      )}
      {!error && run.state === 'failed' && (
        <p className="font-sans text-[12px] text-error/90">{run.error}</p>
      )}
    </div>
  )
}

/** A refused backup: the Worker's sentence, then "Back up anyway" with a confirm naming what it replaces. */
function ConflictRow({ conflict }: { conflict: Extract<Run, { state: 'conflict' }> }) {
  const [confirming, setConfirming] = useState(false)
  const action = useAct()
  const { latest } = conflict
  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-2" data-cloud-conflict>
      <p className="font-sans text-[12px] leading-relaxed text-warning">{conflict.error}</p>
      {confirming ? (
        <div className="space-y-1.5">
          <p className="font-sans text-[12px] leading-relaxed text-muted-foreground">
            {latest
              ? `This replaces the backup ${latest.machine} made ${since(latest.at)} (${latest.id}) as the latest. Its history stays in that backup until retention prunes it.`
              : 'This replaces the latest backup from another machine. Its history stays in that backup until retention prunes it.'}
          </p>
          <div className="flex justify-end gap-1.5">
            <Button
              className="h-6 font-sans text-[12px]"
              onClick={() => setConfirming(false)}
              size="xs"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="h-6 font-sans text-[12px]"
              disabled={action.busy}
              onClick={() =>
                action.act(async () => {
                  setConfirming(false)
                  await backUp(true)
                })
              }
              size="xs"
              variant="destructive"
            >
              Replace it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            className="h-6 font-sans text-[12px]"
            onClick={() => setConfirming(true)}
            size="xs"
            variant="outline"
          >
            Back up anyway
          </Button>
        </div>
      )}
      {action.error && <p className="font-sans text-[12px] text-error">{action.error}</p>}
    </div>
  )
}

/** The restore command, for reference: what another machine runs to take this backup. */
function RestoreRow({ name }: { name: string }) {
  return (
    <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
      Restore elsewhere with{' '}
      <code className="rounded-sm bg-muted px-1 py-0.5 text-foreground/85">
        pnpm restore {name}
      </code>
    </div>
  )
}

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

/** The status line's cloud item: when this project was last backed up, and the popover to back up now. */
function CloudStatus() {
  const state = useLocal()
  if (!state || state.status === 'off') return null
  if (state.status === 'local')
    return (
      <span
        className="flex items-center gap-1.5 text-muted-foreground/70"
        title="The project has no GitHub origin, so it is not backed up"
      >
        <CloudIcon className="size-3" />
        not backed up
      </span>
    )
  if (state.status === 'satellite')
    return (
      <span
        className="flex items-center gap-1.5 text-muted-foreground/70"
        title="This machine is a satellite (cloud.satellite): it never backs up, so it cannot replace another machine's backups"
      >
        <CloudIcon className="size-3" />
        satellite · no backups
      </span>
    )
  const { run, lastBackup } = state
  const status = headline(run, lastBackup, since)
  // The first chapter's backups are the project's; later chapters name theirs, as the dream cards do.
  const label =
    state.chapter && state.chapter.number > 1
      ? `Chapter ${state.chapter.number} · ${state.chapter.name} · ${status}`
      : status
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            statusButton,
            run.state === 'uploading' && 'text-brand',
            run.state === 'conflict' && 'text-warning',
          )}
          data-cloud-status
          title="Cloud backup"
          type="button"
        >
          {run.state === 'uploading' ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <CloudIcon className="size-3" />
          )}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0 font-mono" side="top">
        <BackupRow state={state} />
        {run.state === 'conflict' && <ConflictRow conflict={run} />}
        <RestoreRow name={state.name} />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [CloudStatus], overlay: [JoinDialog] },
  commands: [
    { id: 'cloud.join', title: 'Join cloud backups', run: (context) => context.open(joinDialog) },
  ],
})
