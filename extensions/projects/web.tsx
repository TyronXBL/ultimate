import { ExternalLinkIcon, FolderOpenIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatAgo,
  ProjectChip,
  shortenPath,
  useAction,
  useConversations,
  useDialog,
  useSystem,
  useUltimate,
} from '@/sdk'
import { loopback, refetchPreviews, show, usePreviews, useShown } from '../instance/ui.tsx'
import type { Preview } from '../instance/ui.tsx'
import { ListAction, StartAction } from './refs.ts'
import type { LocalProject } from './refs.ts'

const openFolder = 'projects.open'

/**
 * Where this window goes to reach a running project: on a loopback page its port on this page's host (so
 * `ultimate.localhost` stays), elsewhere its tailnet address. A reason when it has none reachable from here.
 */
function address(project: LocalProject): { href: string } | { reason: string } | undefined {
  if (!project.url) return undefined
  if (!loopback)
    return project.tailnet ? { href: project.tailnet } : { reason: 'Only on this machine' }
  const url = new URL(location.origin)
  url.port = new URL(project.url).port
  return { href: url.href }
}

/** Starts the project in `root` and goes there; the message to show when that fails or it is not reachable. */
async function start(root: string): Promise<string | undefined> {
  try {
    const target = address(await api.action(StartAction, { root }))
    if (target && 'href' in target) {
      location.assign(target.href)
      return undefined
    }
    return 'It runs now, but only on this machine.'
  } catch (error) {
    return errorMessage(error)
  }
}

const port = (url: string) => {
  const value = new URL(url).port
  return value && `:${value}`
}

const sectionLabel =
  'px-2 pt-1 pb-1.5 font-mono text-[10.5px] font-normal tracking-wider text-muted-foreground uppercase'
const item = 'gap-2 py-1.5'
const meta = 'shrink-0 font-mono text-[11px] text-muted-foreground'

function Separator() {
  return <div className="-mx-1 my-1 h-px bg-border/70" role="separator" />
}

/** A project's status as a dot: running (green), stopped (hollow), or running out of reach (grey). */
function Dot({ state }: { state: 'running' | 'stopped' | 'off' | 'preview' }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'running' && 'bg-success',
        state === 'preview' && 'bg-brand',
        state === 'off' && 'bg-muted-foreground/40',
        state === 'stopped' && 'ring-1 ring-muted-foreground/60 ring-inset',
      )}
    />
  )
}

/**
 * The title bar's project chip as the menu for every Ultimate this window can show: this machine's projects (a running
 * one opens in this window, a stopped one starts first), "Open folder…", the previews `instance` runs (loopback pages
 * only, shown in its frame) and the user's other machines (new tab). The lists refresh when it opens.
 */
function Switcher() {
  const projects = useAction(ListAction, null, { onError: () => {} })
  const shown = useShown()?.preview
  const all = usePreviews()
  const previews = (loopback && all?.filter((preview) => preview.running)) || []
  const conversations = useConversations()
  const system = useSystem()
  const { open } = useUltimate()
  const [starting, setStarting] = useState<{ root: string; error?: string }>()
  const title = (preview: Preview) =>
    conversations.find((conversation) => conversation.id === preview.conversationId)?.title
  const local = projects.data?.projects ?? []
  const remotes = projects.data?.remotes ?? []
  const startable = local.some((project) => !project.current && !project.url && project.root)
  const begin = async (root: string) => {
    setStarting({ root })
    const error = await start(root)
    if (error) setStarting({ root, error })
    await projects.refetch()
  }

  const row = (project: LocalProject) => {
    const target = address(project)
    const busy = starting?.root === project.root ? starting : undefined
    const here = project.current && !shown
    const select = (event: Event) => {
      if (project.current) show(undefined)
      else if (target && 'href' in target) location.assign(target.href)
      else if (project.root) {
        // Starting takes up to a minute: the menu stays open to show it.
        event.preventDefault()
        // oxlint-disable-next-line typescript/no-floating-promises -- begin shows failures in the row and never rejects.
        if (!busy || busy.error) void begin(project.root)
      }
    }
    const off = target && 'reason' in target
    const dead = !project.url && !project.root
    return (
      <div key={project.root ?? project.name}>
        <DropdownMenuItem
          className={item}
          data-project={project.name}
          disabled={!!off || dead || (!!starting && !starting.error && !busy)}
          onSelect={select}
          title={project.root && shortenPath(project.root, { home: system?.machine.home })}
        >
          <Dot state={project.current || project.url ? (off ? 'off' : 'running') : 'stopped'} />
          <span className={cn('min-w-0 flex-1 truncate text-[13px]', here && 'text-brand')}>
            {project.name}
          </span>
          {project.current ? (
            <span className={meta}>current</span>
          ) : target && 'href' in target ? (
            <span className={meta}>{port(target.href)}</span>
          ) : off ? (
            <span className="shrink-0 text-[11.5px] text-muted-foreground">{target.reason}</span>
          ) : busy && !busy.error ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px]">
              <LoaderCircleIcon className="size-3 text-muted-foreground motion-safe:animate-spin" />
              <Shimmer>Starting…</Shimmer>
            </span>
          ) : project.root ? (
            <span className="flex shrink-0 items-center gap-2">
              {project.activeAt && <span className={meta}>{formatAgo(project.activeAt)}</span>}
              <span className="rounded-sm px-1.5 text-[11.5px] leading-5 text-foreground/80 ring-1 ring-border">
                {busy?.error ? 'Retry' : 'Start'}
              </span>
            </span>
          ) : (
            <span className="shrink-0 text-[11.5px] text-muted-foreground">No folder</span>
          )}
        </DropdownMenuItem>
        {busy?.error && (
          <p className="px-2 pb-1.5 pl-5.5 text-[11.5px] leading-snug wrap-anywhere text-error">
            {busy.error}
          </p>
        )}
      </div>
    )
  }

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(next) => {
        if (!next) return
        // oxlint-disable-next-line typescript/no-floating-promises -- useAction resolves undefined rather than rejecting.
        void projects.refetch()
        refetchPreviews()
      }}
    >
      <DropdownMenuTrigger asChild>
        <ProjectChip className={cn(shown && 'bg-brand/10')} menu>
          {shown ? (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-brand" />#{shown.conversationId} ·{' '}
              {port(shown.url)}
            </span>
          ) : (
            previews.length > 0 && (
              <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground max-md:hidden">
                {previews.length} {previews.length === 1 ? 'preview' : 'previews'}
              </span>
            )
          )}
        </ProjectChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80 max-w-[calc(100vw-1rem)]"
        data-projects-menu
        sideOffset={4}
      >
        <DropdownMenuLabel className={sectionLabel}>Projects</DropdownMenuLabel>
        {local.map(row)}
        {!projects.data &&
          (projects.error ? (
            <p className="px-2 py-1.5 text-[12px] leading-snug text-error">
              {projects.error.message}
            </p>
          ) : (
            <p className="px-2 py-1.5 text-[12px]">
              <Shimmer>Looking for projects…</Shimmer>
            </p>
          ))}
        <DropdownMenuItem className={item} onSelect={() => open(openFolder)}>
          <FolderOpenIcon className="size-3.5" />
          <span className="flex-1 text-[13px]">Open folder…</span>
        </DropdownMenuItem>
        {startable && (
          <p className="px-2 pt-0.5 pb-1 text-[11px] leading-snug text-muted-foreground">
            Starting a project resumes its unfinished work and automations.
          </p>
        )}
        {previews.length > 0 && (
          <>
            <Separator />
            <DropdownMenuLabel className={sectionLabel}>Previews</DropdownMenuLabel>
            {previews.map((preview) => (
              <DropdownMenuItem
                className={item}
                data-instance={preview.id}
                key={preview.id}
                onSelect={() => show(preview)}
              >
                <Dot state="preview" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[13px]',
                    shown?.id === preview.id && 'text-brand',
                  )}
                >
                  #{preview.conversationId}
                  {title(preview) && (
                    <span className="text-muted-foreground"> {title(preview)}</span>
                  )}
                </span>
                <span className={meta}>{port(preview.url)}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {remotes.length > 0 && (
          <>
            <Separator />
            <DropdownMenuLabel className={sectionLabel}>Other machines</DropdownMenuLabel>
            {remotes.map((remote) => (
              <DropdownMenuItem
                className={item}
                data-remote={remote.url}
                key={remote.url}
                onSelect={() => window.open(remote.url, '_blank', 'noreferrer')}
                title={remote.url}
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {remote.name}
                  <span className="text-muted-foreground"> {remote.machine}</span>
                </span>
                <ExternalLinkIcon className="size-3" />
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Open folder…": a path on this machine, started (or opened when it runs) and switched to. */
function OpenFolder() {
  const [open, setOpen] = useDialog(openFolder)
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] gap-0 p-0 sm:max-w-[28rem]"
        data-projects-open
      >
        {open && <OpenFolderBody onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function OpenFolderBody({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!path.trim() || busy) return
    setBusy(true)
    setFailure(undefined)
    const error = await start(path.trim())
    // Gone on success: the window is on its way to the project.
    if (!error) return
    setFailure(error)
    setBusy(false)
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <div className="space-y-3 px-5 pt-5 pb-4">
        <DialogTitle className="flex items-center gap-2 text-base">
          <FolderOpenIcon className="size-4 text-brand" />
          Open folder
        </DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
          Run Ultimate in a folder on this machine and switch this window to it. A project opened
          before resumes its unfinished work and automations.
        </DialogDescription>
        <input
          aria-label="Folder"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to take this one field
          autoFocus
          className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 font-mono text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
          disabled={busy}
          onChange={(event) => setPath(event.target.value)}
          placeholder="~/code/my-app"
          spellCheck={false}
          value={path}
        />
        {failure && <p className="text-[12px] leading-snug wrap-anywhere text-error">{failure}</p>}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-5 py-3">
        {busy && (
          <span className="mr-auto text-[12px]">
            <Shimmer>Starting, this can take a minute…</Shimmer>
          </span>
        )}
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!path.trim() || busy} size="sm" type="submit">
          {busy && <LoaderCircleIcon className="motion-safe:animate-spin" />}
          Open
        </Button>
      </footer>
    </form>
  )
}

export default defineWebExtension({
  slots: { 'titlebar.project': [Switcher], overlay: [OpenFolder] },
  commands: [
    { id: 'projects.open', title: 'Open folder…', run: (context) => context.open(openFolder) },
  ],
})
