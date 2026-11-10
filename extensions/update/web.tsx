import {
  ArrowDownIcon,
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  events,
  formatAgo,
  useAction,
  useRestart,
  useSystem,
  useUltimate,
} from '@/sdk'
import { standingOf } from './item.ts'
import type { Standing } from './item.ts'
import { CheckAction, MergeAction, StateAction, UpdateAction } from './refs.ts'
import type { Layers, UpdateResult, UpdateState } from './refs.ts'

/** What the item shows: everything but a preview, which shows nothing. */
type Shown = Exclude<Standing, { kind: 'preview' }>

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

const short = (root: string) => root.replace(/^\/(?:home|Users)\/[^/]+/, '~')

/** "extensions, web · server · lockfile": what the range touches, core and lockfile marked. */
function Touches({ layers }: { layers: Layers }) {
  const parts: ReactNode[] = []
  if (layers.live) parts.push(<span key="live">extensions, web</span>)
  if (layers.core)
    parts.push(
      <span className="text-warning" key="core">
        server
      </span>,
    )
  if (layers.lockfile)
    parts.push(
      <span className="text-warning" key="lock">
        lockfile
      </span>,
    )
  if (layers.bin)
    parts.push(
      <span className="text-warning" key="bin">
        bin
      </span>,
    )
  return (
    <span>
      {parts.map((part, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Positional layer fragments built for this render.
        <span key={index}>
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </span>
  )
}

/** What has to happen after an update with `layers`, one line each. */
function After({ layers, install }: { layers: Layers; install?: UpdateResult & { ok: true } }) {
  const lines: ReactNode[] = []
  if (layers.live) lines.push('extensions and web reload by themselves')
  if (layers.core || layers.lockfile)
    lines.push(
      <span className="text-warning">
        restart this Ultimate ({layers.core ? 'server changed' : 'packages changed'}), and every
        other one running from this clone
      </span>,
    )
  if (layers.lockfile && install?.install !== 'done')
    lines.push(install?.install === 'failed' ? 'pnpm install failed' : 'pnpm install')
  if (layers.bin)
    lines.push(
      <span className="text-warning">
        bin/ changed: restart the supervisor (systemctl --user restart ultimate, or launchctl
        kickstart -k gui/$UID/com.ultimate.app)
      </span>,
    )
  return (
    <ul className="space-y-0.5">
      {lines.map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Fixed instructions derived from this update's layers.
        <li className="flex gap-1.5" key={index}>
          <span className="text-muted-foreground">·</span>
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  )
}

/** Fetch origin now: shown while nothing was just updated, so a dirty clone can be re-checked after fixing it. */
function CheckNow({ checking, onClick }: { checking: boolean; onClick: () => void }) {
  return (
    <Button
      className="h-7 font-sans text-[12px] text-muted-foreground"
      data-update-check
      disabled={checking}
      onClick={onClick}
      size="sm"
      variant="ghost"
    >
      {checking ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : (
        <RefreshCwIcon className="size-3" />
      )}
      {checking ? 'Checking…' : 'Check now'}
    </Button>
  )
}

function Popup({
  state,
  standing,
  busy,
  checking,
  error,
  run,
  check,
  merge,
}: {
  state: UpdateState
  standing: Shown
  busy: boolean
  checking: boolean
  error?: string
  run: () => void
  check: () => void
  merge: () => void
}) {
  const coreStale = useSystem()?.code.coreStale
  const { updated } = standing
  // Under a summary the commit list folds to the first few.
  const shown = Math.min(state.commits.length, state.summary ? 3 : 5)
  return (
    <>
      <div className="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div className="section-label">Ultimate update</div>
        <div className="truncate text-muted-foreground" title={state.root}>
          {short(state.root)}
        </div>
      </div>
      <div className="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        {standing.kind === 'current' && !updated ? (
          <div>
            {checking ? (
              'Checking origin for new commits…'
            ) : (
              <>
                Ultimate is <span className="text-success">up to date</span> with origin/
                {state.branch ?? 'main'}
              </>
            )}
          </div>
        ) : updated ? (
          <>
            <div>
              <span className="text-success">Updated</span> {updated.from}..
              {updated.to} · {updated.commits} {updated.commits === 1 ? 'commit' : 'commits'}
              {updated.install === 'done' && ' · pnpm install done'}
            </div>
            <After install={updated} layers={updated.layers} />
            {updated.install === 'failed' && updated.installError && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-error">
                {updated.installError}
              </pre>
            )}
          </>
        ) : standing.kind === 'behind' ? (
          <>
            <div>
              {state.branch ?? 'main'} is {state.behind} {state.behind === 1 ? 'commit' : 'commits'}{' '}
              behind origin/
              {state.branch ?? 'main'}
            </div>
            {state.summary && (
              <ul className="space-y-0.5 font-sans text-[12.5px] text-foreground">
                {state.summary.map((line) => (
                  <li className="flex gap-1.5" key={line}>
                    <span className="text-brand">•</span>
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            )}
            <ul className="space-y-0.5">
              {state.commits.slice(0, shown).map((commit) => (
                <li className="flex min-w-0 gap-2" key={commit.sha}>
                  <span className="shrink-0 text-muted-foreground">{commit.sha}</span>
                  <span className="truncate text-foreground/85" title={commit.subject}>
                    {commit.subject}
                  </span>
                </li>
              ))}
              {state.behind > shown && (
                <li className="text-muted-foreground">… {state.behind - shown} more</li>
              )}
            </ul>
            {state.compare && (
              <a
                className="text-muted-foreground hover:text-brand"
                href={state.compare}
                rel="noreferrer"
                target="_blank"
              >
                DiffsHub ↗
              </a>
            )}
            {state.layers && (
              <div className="border-t border-border/60 pt-2">
                <div className="mb-0.5 text-muted-foreground">
                  Touches <Touches layers={state.layers} />
                </div>
                <After layers={state.layers} />
              </div>
            )}
          </>
        ) : (
          <div>
            {standing.kind === 'install'
              ? 'pnpm-lock.yaml differs from the installed packages: pnpm install is owed.'
              : 'Packages or server code changed after this Ultimate started: restart it to load them.'}
          </div>
        )}
        {standing.hold === 'merge' ? (
          <div data-update-diverged>
            {state.branch ?? 'main'} also has {state.ahead}{' '}
            {state.ahead === 1 ? 'commit' : 'commits'} of its own, so it can't fast-forward.
            @ultimate can merge origin into them on a branch and land it once the checks pass.
          </div>
        ) : (
          standing.hold === 'refused' &&
          !updated && (
            <div className="flex items-start gap-1.5 text-warning">
              <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
              <span>Can't update: {standing.reason}. Nothing was stashed, rebased or reset.</span>
            </div>
          )
        )}
        {state.error && (
          <div className="break-words text-error" title={state.error}>
            Last fetch failed: {state.error.split('\n')[0]}
          </div>
        )}
        {error && <div className="break-words text-error">{error}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span className="text-[10.5px] text-muted-foreground">
          {state.fetchedAt !== undefined && !(standing.hold === 'refused' && !updated)
            ? `checked ${formatAgo(state.fetchedAt, Date.now(), { ago: true })}`
            : ''}
        </span>
        <div className="flex items-center gap-1">
          {!updated && <CheckNow checking={checking} onClick={check} />}
          <Action busy={busy} coreStale={coreStale} merge={merge} run={run} standing={standing} />
        </div>
      </div>
    </>
  )
}

/** The popover's main button: install, restart or update; none while the clone is current. */
function Action({
  standing,
  busy,
  coreStale,
  run,
  merge,
}: {
  standing: Shown
  busy: boolean
  coreStale?: boolean
  run: () => void
  merge: () => void
}) {
  const restart = useRestart()
  const refused = standing.hold === 'refused' ? standing.reason : undefined
  const restartButton = (
    <Button
      className="h-7 font-sans text-[12px]"
      disabled={restart.busy}
      onClick={restart.run}
      size="sm"
      variant="outline"
    >
      {restart.busy ? 'Restarting…' : 'Restart now'}
    </Button>
  )
  if (standing.kind === 'current') return standing.updated && coreStale ? restartButton : null
  if (standing.kind === 'restart') return standing.reload || coreStale ? restartButton : null
  return (
    <>
      {standing.kind === 'install' ? (
        <Button
          className="h-7 font-sans text-[12px]"
          disabled={busy || !!refused}
          onClick={run}
          size="sm"
          title={refused}
          variant="outline"
        >
          {busy ? 'Installing…' : 'Retry pnpm install'}
        </Button>
      ) : standing.hold === 'merge' ? (
        <Button
          className="h-7 font-sans text-[12px]"
          data-update-merge
          disabled={busy}
          onClick={merge}
          size="sm"
          variant="outline"
        >
          {busy ? 'Asking…' : 'Update with @ultimate'}
        </Button>
      ) : (
        <Button
          className="h-7 font-sans text-[12px]"
          data-update-now
          disabled={busy || !!refused}
          onClick={run}
          size="sm"
          title={refused}
          variant="outline"
        >
          {busy ? 'Updating…' : 'Update now'}
        </Button>
      )}
    </>
  )
}

/** The status-line item: quiet while the clone is current, prominent while it is behind or owes a restart. */
function Update() {
  const { data, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one tries again.
    { onError: () => {}, every: 60_000 },
  )
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const { showSurface, switchConversation } = useUltimate()
  const state = data
  if (!state) return null
  const standing = standingOf(state)
  if (standing.kind === 'preview') return null
  const { kind } = standing
  const refused = standing.hold === 'refused'
  const check = () => {
    setChecking(true)
    setError(undefined)
    api
      .action(CheckAction)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      // The check leaves its answer as the server's state.
      .finally(() => void refetch().finally(() => setChecking(false)))
  }
  const run = () => {
    setBusy(true)
    setError(undefined)
    api
      .action(UpdateAction)
      // A refusal comes back in the refreshed state; only a failing command is shown here.
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => {
        setBusy(false)
        // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
        void refetch()
      })
  }
  // Hands the merge to @ultimate and opens its conversation, where the branch it starts shows up.
  const merge = () => {
    setBusy(true)
    setError(undefined)
    api
      .action(MergeAction)
      .then(({ id }) => {
        events.emit('ultimate:sent', { conversationId: id })
        showSurface('agent')
        switchConversation(id)
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false))
  }
  const label =
    kind === 'current' ? (
      <>
        {checking ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : (
          <CheckIcon className="size-3" />
        )}
        <span className="max-md:hidden">up to date</span>
      </>
    ) : kind === 'install' ? (
      <>
        <TriangleAlertIcon className="size-3" />
        install owed
      </>
    ) : kind === 'restart' ? (
      <>
        <CheckIcon className="size-3" />
        <span className="max-md:hidden">updated · </span>restart
      </>
    ) : (
      <>
        {busy || checking ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : refused ? (
          <TriangleAlertIcon className="size-3" />
        ) : (
          <ArrowDownIcon className="size-3" />
        )}
        {state.behind} new<span className="max-md:hidden"> · update</span>
      </>
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            statusButton,
            kind === 'current'
              ? 'text-muted-foreground/70 hover:text-foreground'
              : busy
                ? 'text-brand'
                : kind !== 'behind' || refused
                  ? 'text-warning'
                  : 'text-brand',
          )}
          data-update
          title="Updates to the Ultimate clone"
          type="button"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <Popup
          busy={busy}
          check={check}
          checking={checking}
          error={error}
          merge={merge}
          run={run}
          standing={standing}
          state={state}
        />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Update, order: -2 }] },
})
