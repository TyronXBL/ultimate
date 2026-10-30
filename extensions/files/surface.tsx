import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeOffIcon,
  FileCodeIcon,
  FileIcon,
  FolderOpenIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  cn,
  errorMessage,
  formatBytes,
  Header,
  StatusLine,
  useAction,
  useCopy,
  useExtensionUiState,
  useStore,
  useViewport,
} from '@/sdk'
import { reachedTarget, useShown, useTarget } from './link.tsx'
import { ReadAction, ScopesAction, TreeAction } from './refs.ts'
import type { FileContent, FileScope } from './refs.ts'
import { ScopePicker } from './scope.tsx'
import { FileTree } from './tree.tsx'
import { Code, Loading, Markdown, Notice, Picture } from './view.tsx'

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)
const lineCount = (text: string) =>
  text ? text.split('\n').length - Number(text.endsWith('\n')) : 0
const splitPath = (path: string) => {
  const slash = path.lastIndexOf('/') + 1
  return [path.slice(0, slash), path.slice(slash)] as const
}

/** The scope as a sentence names it: `main`, or `#123 Fix the sidebar`. */
function scopeLabel(scopes: FileScope[] | undefined, conversation: number | undefined) {
  const scope = scopes?.find((item) => item.conversation === conversation)
  if (conversation === undefined) return scope?.branch ?? 'the project checkout'
  return scope?.title ? `#${conversation} ${scope.title}` : `#${conversation}`
}

const quietButton =
  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2.5 font-sans text-[12px] text-foreground/90 hover:bg-accent/60 pointer-coarse:h-9'

/** The open file's path; a click copies it. */
function PathButton({ path }: { path: string }) {
  const { copied, copy } = useCopy()
  const [directory, name] = splitPath(path)
  return (
    <button
      className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-[12px] hover:bg-accent/60"
      onClick={() => copy(path)}
      title={copied ? 'Copied' : `Copy ${path}`}
      type="button"
    >
      <span className="min-w-0 truncate [direction:rtl]">
        <span className="[direction:ltr] [unicode-bidi:isolate]">
          <span className="text-muted-foreground">{directory}</span>
          <span className="text-foreground">{name}</span>
        </span>
      </span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-success" />
      ) : (
        <CopyIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      )}
    </button>
  )
}

/** Files elsewhere in the scope with the missing file's name: it may have moved. */
function Namesakes({
  files,
  path,
  onPick,
}: {
  files: string[] | undefined
  path: string
  onPick: (path: string) => void
}) {
  const name = `/${splitPath(path)[1]}`
  const found = files?.filter((file) => `/${file}`.endsWith(name)).slice(0, 5) ?? []
  if (found.length === 0) return null
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-muted-foreground/70">Same name here:</span>
      {found.map((file) => (
        <button
          className="cursor-pointer break-all text-brand hover:underline pointer-coarse:py-1.5"
          key={file}
          onClick={() => onPick(file)}
          type="button"
        >
          {file}
        </button>
      ))}
    </div>
  )
}

/** Size, lines and kind of the file on screen. */
function meta(file: FileContent) {
  if (file.kind === 'text') {
    const lines = lineCount(file.text)
    return `${formatBytes(file.size)} · ${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`
  }
  if (file.kind === 'image')
    return `${formatBytes(file.size)} · ${file.mime.replace('image/', '').replace('+xml', '')}`
  return `${formatBytes(file.size)} · binary`
}

/** Rendered Markdown or its source. */
function ModeToggle({ mode, onChange }: { mode: string; onChange: (mode: string) => void }) {
  return (
    <div className="flex shrink-0 items-center rounded-md border border-border/70 p-0.5">
      {(['rendered', 'source'] as const).map((name) => (
        <button
          aria-pressed={mode === name}
          className={cn(
            'flex h-6 cursor-pointer items-center rounded-sm px-2 font-mono text-[11px] text-muted-foreground transition-colors',
            mode === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
          )}
          key={name}
          onClick={() => onChange(name)}
          title={name === 'rendered' ? 'Show as a document' : 'Show the Markdown source'}
          type="button"
        >
          {name === 'rendered' ? 'Rendered' : 'Source'}
        </button>
      ))}
    </div>
  )
}

/** The file list on a phone: a full-height sheet over the file, with the filter and the tree. */
function FileSheet({
  open,
  onOpenChange,
  scope,
  path,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: string
  path: string | undefined
  children: ReactNode
}) {
  const { copied, copy } = useCopy()
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-auto bottom-0 left-0 flex h-[92dvh] max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-2xl rounded-b-none border-x-0 border-b-0 p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-bottom-8"
        // The sheet is for tapping rows; a keyboard would cover it until the user asks for the filter.
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Files on {scope}</DialogTitle>
        <DialogDescription className="sr-only">
          Filter and browse the files of {scope}, and pick one to read.
        </DialogDescription>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-4">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            Files <span className="text-muted-foreground">on {scope}</span>
          </span>
          {path && (
            <button className={quietButton} onClick={() => copy(path)} type="button">
              {copied ? (
                <CheckIcon className="size-3.5 text-success" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
              Copy path
            </button>
          )}
          <button
            aria-label="Close"
            className="flex size-10 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** The Files surface: a scope's files on the left, the one open on the right, read-only. */
export default function FilesViewer() {
  const [shown, setShown] = useShown()
  const conversation = shown.conversation
  const scope = conversation === undefined ? {} : { conversation }
  const phone = useViewport() === 'phone'
  const wrap = useStore((state) => state.ui.codeWrap)
  const [preferred, setPreferred] = useExtensionUiState('markdown', 'rendered')
  // A link to a line of a Markdown file shows its source, for that file only: the preference stays as it was.
  const [sourceOf, setSourceOf] = useState<string>()
  const [picking, setPicking] = useState(false)
  const [sheet, setSheet] = useState(false)
  const target = useTarget()
  const scopes = useAction(ScopesAction, null, { onError: () => undefined })
  const tree = useAction(TreeAction, scope, { onError: () => undefined })
  const files = tree.data?.files
  // Nothing chosen yet: the project's README, as a repository page opens.
  const path = shown.path ?? (files?.includes('README.md') ? 'README.md' : undefined)
  const read = useAction(
    ReadAction,
    { ...scope, path: path ?? '' },
    { enabled: path !== undefined, onError: () => undefined },
  )
  const file = read.data
  const markdown = path !== undefined && isMarkdown(path)
  const failed = read.error && !read.loading ? errorMessage(read.error) : undefined
  useEffect(() => {
    if (target !== undefined && markdown) setSourceOf(path)
  }, [target, markdown, path])
  const mode = sourceOf === path ? 'source' : preferred
  const setMode = (next: string) => {
    setSourceOf(undefined)
    setPreferred(next)
  }
  // A file without lines to scroll to consumes the target, so the next file does not inherit it.
  useEffect(() => {
    if (target !== undefined && (failed || (file && file.kind !== 'text'))) reachedTarget()
  }, [target, failed, file])
  const label = scopeLabel(scopes.data, conversation)
  const pick = (next: string) => {
    setSheet(false)
    setShown({ ...scope, path: next })
  }
  const changeScope = (next: number | undefined) =>
    setShown({ ...(next !== undefined && { conversation: next }), ...(path && { path }) })
  const otherScope = (
    <button className={quietButton} onClick={() => setPicking(true)} type="button">
      Choose another scope
    </button>
  )
  // On a phone the tree is in the sheet: a state without a file offers it.
  const browse = phone && files && (
    <button className={quietButton} onClick={() => setSheet(true)} type="button">
      Browse {files.length} files
    </button>
  )
  const picker = (
    <ScopePicker
      compact={phone}
      current={conversation}
      onChange={changeScope}
      onOpenChange={setPicking}
      open={picking}
      scopes={scopes.data}
    />
  )
  const treeFailed = tree.error && !tree.loading ? errorMessage(tree.error) : undefined
  const list = files ? (
    <FileTree current={path} files={files} onPick={pick} roomy={phone} />
  ) : treeFailed ? (
    <p className="px-3 py-4 font-mono text-[11.5px] text-muted-foreground/70">{treeFailed}</p>
  ) : (
    <div className="space-y-2 p-3">
      {[60, 80, 70, 50, 75].map((width) => (
        <div
          className="h-3.5 animate-pulse rounded-sm bg-muted"
          key={width}
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  )

  let body: ReactNode
  if (treeFailed && !file)
    body = (
      <Notice title={`Can’t list files on ${label}`}>
        <span>{treeFailed}</span>
        {otherScope}
      </Notice>
    )
  else if (path === undefined)
    body = files ? (
      <Notice icon={FolderOpenIcon} title="Pick a file to read">
        {browse}
      </Notice>
    ) : (
      <Loading />
    )
  else if (failed?.startsWith('Hidden'))
    body = (
      <Notice icon={EyeOffIcon} title="Hidden">
        <span>Its name suggests secrets, so Files never shows it.</span>
        {browse}
      </Notice>
    )
  else if (failed?.startsWith('Not found'))
    body = (
      <Notice title={`Not found on ${label}`}>
        <span className="break-all">{path}</span>
        <Namesakes files={files} onPick={pick} path={path} />
        {(scopes.data?.length ?? 0) > 1 && otherScope}
        {browse}
      </Notice>
    )
  else if (failed)
    body = (
      <Notice title="Can’t show this file">
        <span>{failed}</span>
      </Notice>
    )
  else if (!file) body = <Loading />
  else if (file.kind === 'binary')
    body = (
      <Notice icon={FileIcon} title="Binary file">
        <span>{formatBytes(file.size)}, not shown</span>
      </Notice>
    )
  else if (file.kind === 'image') body = <Picture file={file} />
  else if (file.text === '') body = <Notice icon={FileIcon} title="Empty file" />
  else if (markdown && mode !== 'source')
    body = <Markdown conversation={conversation} path={file.path} text={file.text} />
  else body = <Code line={target} path={file.path} text={file.text} wrap={wrap} />

  return (
    <>
      <Header>
        <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <FolderOpenIcon className="size-4 text-muted-foreground" />
          <span className="max-md:hidden">Files</span>
        </span>
        {!phone && picker}
        {phone ? (
          <button
            className="flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 px-2 font-mono text-[12px]"
            onClick={() => setSheet(true)}
            title="Browse files"
            type="button"
          >
            <span className="min-w-0 truncate">
              {path ? (
                <>
                  <span className="text-muted-foreground">
                    {splitPath(path)[0].split('/').at(-2)?.concat('/')}
                  </span>
                  {splitPath(path)[1]}
                </>
              ) : (
                'Browse files'
              )}
            </span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </button>
        ) : (
          path && <PathButton path={path} />
        )}
        {phone && picker}
        {file && !phone && (
          <span className="shrink-0 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground max-lg:hidden">
            {meta(file)}
          </span>
        )}
        {markdown &&
          file?.kind === 'text' &&
          file.text &&
          (phone ? (
            <button
              aria-pressed={mode === 'source'}
              className={cn(
                'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground',
                mode === 'source' && 'bg-accent text-foreground',
              )}
              onClick={() => setMode(mode === 'source' ? 'rendered' : 'source')}
              title={mode === 'source' ? 'Show as a document' : 'Show the Markdown source'}
              type="button"
            >
              <FileCodeIcon className="size-4" />
            </button>
          ) : (
            <ModeToggle mode={mode} onChange={setMode} />
          ))}
      </Header>
      <div className="flex min-h-0 flex-1">
        {!phone && (
          <nav
            aria-label="Files"
            className="flex w-64 shrink-0 flex-col border-r border-border/70 bg-sidebar"
          >
            {list}
          </nav>
        )}
        <main
          className="flex min-w-0 flex-1 flex-col"
          // Each file opens at its top, not where the last one was scrolled to.
          key={`${conversation ?? ''}:${path ?? ''}`}
        >
          {file?.kind === 'text' && file.truncated && (
            <p className="shrink-0 border-b border-border/70 bg-warning/10 px-4 py-1.5 font-mono text-[11.5px] text-warning">
              Truncated at 2 MB: showing the start of {formatBytes(file.size)}.
            </p>
          )}
          {body}
        </main>
      </div>
      {phone && (
        <FileSheet onOpenChange={setSheet} open={sheet} path={path} scope={label}>
          {list}
        </FileSheet>
      )}
      <StatusLine />
    </>
  )
}
