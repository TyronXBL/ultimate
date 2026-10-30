import { ChevronRightIcon, SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn, useExtensionUiState } from '@/sdk'

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] }
type Row =
  | { kind: 'dir'; path: string; name: string; depth: number; open: boolean }
  | { kind: 'file'; path: string; name: string; depth: number }

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
/** `a/b/c.md` → `['a', 'a/b']`. */
const ancestors = (path: string) =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/'))

function build(files: string[]) {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    let dir = root
    for (const part of file.split('/').slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${part}` : part
      let next = dir.dirs.get(part)
      if (!next) dir.dirs.set(part, (next = { name: part, path, dirs: new Map(), files: [] }))
      dir = next
    }
    dir.files.push(file)
  }
  return root
}

/** The visible rows: directories first, then files, each directory's contents only while it is expanded. */
function rows(dir: Dir, expanded: Set<string>, depth = 0, out: Row[] = []) {
  for (const child of [...dir.dirs.values()].toSorted((a, b) => a.name.localeCompare(b.name))) {
    const open = expanded.has(child.path)
    out.push({ kind: 'dir', path: child.path, name: child.name, depth, open })
    if (open) rows(child, expanded, depth + 1, out)
  }
  for (const file of dir.files) out.push({ kind: 'file', path: file, name: fileName(file), depth })
  return out
}

/** Paths containing every word of `query`, those whose name matches first. */
function matches(files: string[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const found = files.filter((file) => {
    const lower = file.toLowerCase()
    return words.every((word) => lower.includes(word))
  })
  const last = words.at(-1) ?? ''
  return found.toSorted(
    (a, b) =>
      Number(!fileName(b).toLowerCase().includes(last)) -
        Number(!fileName(a).toLowerCase().includes(last)) || a.length - b.length,
  )
}

const limit = 200
const row =
  'flex w-full cursor-pointer items-center gap-1 py-[3px] pr-3 text-left font-mono text-[12px] outline-none hover:bg-accent/60 focus-visible:bg-accent/60'

/** The scope's files: a filter field over a directory tree, the open file highlighted and its directories expanded. */
export function FileTree({
  files,
  current,
  onPick,
  roomy,
}: {
  files: string[]
  current: string | undefined
  onPick: (path: string) => void
  /** Rows a finger can hit, on a phone. */
  roomy?: boolean
}) {
  const [query, setQuery] = useState('')
  const [stored, setExpanded] = useExtensionUiState<string[]>('expanded', [])
  const expanded = useMemo(() => new Set(stored), [stored])
  const tree = useMemo(() => build(files), [files])
  const list = useRef<HTMLDivElement>(null)
  // The open file's directories open when it does (collapsing one later sticks); other expansions stay as they were.
  useEffect(() => {
    if (!current) return
    setExpanded((previous) => {
      const missing = ancestors(current).filter((dir) => !previous.includes(dir))
      return missing.length > 0 ? [...previous, ...missing] : previous
    })
  }, [current, setExpanded])
  // Bring the open file's row into view once per file, as soon as its directories have opened.
  const revealed = useRef<string>(undefined)
  useEffect(() => {
    if (!current || revealed.current === current) return
    const open = list.current?.querySelector(`[data-path="${CSS.escape(current)}"]`)
    if (!open) return
    revealed.current = current
    const box = list.current?.getBoundingClientRect()
    const at = open.getBoundingClientRect()
    if (box && (at.top < box.top || at.bottom > box.bottom))
      open.scrollIntoView({ block: 'center' })
  })
  const toggle = (path: string) =>
    setExpanded((previous) =>
      previous.includes(path)
        ? previous.filter((dir) => dir !== path && !dir.startsWith(`${path}/`))
        : [...previous, path],
    )
  const found = query.trim() ? matches(files, query) : undefined
  const visible = found ? undefined : rows(tree, expanded)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 border-b border-border/70 p-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          aria-label="Filter files"
          autoComplete="off"
          className={cn(
            'h-7 w-full rounded-md border border-border/70 bg-background pr-7 pl-7 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring',
            roomy && 'h-10 text-[16px]',
          )}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation()
              setQuery('')
            }
            if (event.key === 'Enter' && found?.[0]) onPick(found[0])
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              list.current?.querySelector<HTMLElement>('button')?.focus()
            }
          }}
          placeholder={`Filter ${files.length} files`}
          spellCheck={false}
          value={query}
        />
        {query && (
          <button
            aria-label="Clear filter"
            className="absolute top-1/2 right-3.5 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => setQuery('')}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const buttons = [...(list.current?.querySelectorAll<HTMLElement>('button') ?? [])]
          const index = buttons.indexOf(document.activeElement as HTMLElement)
          buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
        }}
        ref={list}
        role="tree"
      >
        {found ? (
          found.length === 0 ? (
            <p className="px-3 py-4 font-mono text-[11.5px] text-muted-foreground/70">
              No file matches “{query.trim()}”
            </p>
          ) : (
            <>
              {found.slice(0, limit).map((path) => (
                <button
                  aria-current={path === current ? 'true' : undefined}
                  className={cn(
                    row,
                    roomy && 'min-h-10 text-[13px]',
                    'pl-3',
                    path === current && 'bg-accent text-foreground hover:bg-accent',
                  )}
                  data-path={path}
                  key={path}
                  onClick={() => onPick(path)}
                  role="treeitem"
                  title={path}
                  type="button"
                >
                  <span className="shrink-0 text-foreground/90">{fileName(path)}</span>
                  <span className="min-w-0 truncate pl-1.5 text-[11px] text-muted-foreground/70">
                    {parentOf(path)}
                  </span>
                </button>
              ))}
              {found.length > limit && (
                <p className="px-3 py-2 font-mono text-[11px] text-muted-foreground/70">
                  {found.length - limit} more: keep typing
                </p>
              )}
            </>
          )
        ) : (
          visible?.map((item) => (
            <button
              aria-current={item.path === current ? 'true' : undefined}
              aria-expanded={item.kind === 'dir' ? item.open : undefined}
              className={cn(
                row,
                roomy && 'min-h-10 text-[13px]',
                item.kind === 'dir' ? 'text-foreground/80' : 'text-foreground/90',
                item.path === current && 'bg-accent text-foreground hover:bg-accent',
              )}
              data-path={item.path}
              key={item.path}
              onClick={() => (item.kind === 'dir' ? toggle(item.path) : onPick(item.path))}
              role="treeitem"
              style={{ paddingLeft: 8 + item.depth * 12 }}
              title={item.path}
              type="button"
            >
              {item.kind === 'dir' ? (
                <ChevronRightIcon
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-100',
                    item.open && 'rotate-90',
                  )}
                />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate">{item.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
