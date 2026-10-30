import { CodeView } from '@pierre/diffs/react'
import type { CodeViewFileItem, CodeViewHandle, CodeViewReactOptions } from '@pierre/diffs/react'
import { FileQuestionIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { defaultRehypePlugins } from 'streamdown'
import type { StreamdownProps } from 'streamdown'
import { MessageResponse } from '@/components/ai/message'
import { Skeleton } from '@/components/ui/skeleton'
import { api, cn, useStore } from '@/sdk'
import { openFile, reachedTarget } from './link.tsx'
import { ReadAction } from './refs.ts'
import type { FileContent } from './refs.ts'

/**
 * Our theme for the code viewer, inside its shadow root, as Review's: our page's tokens inherit into it, so the code
 * takes our mono font and background in both themes, with the vitesse themes for syntax.
 */
const themeCss = `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 12px;
  --diffs-line-height: 19px;
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-fg-number-override: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  --diffs-bg-selection-override: color-mix(in oklab, var(--brand) 22%, transparent);
  --diffs-bg-selection-number-override: color-mix(in oklab, var(--brand) 40%, transparent);
}
[data-gutter] [data-selected-line] { box-shadow: inset 3px 0 0 var(--brand); color: var(--foreground); }
`

/** A quiet line in place of the file: why there is none, with what to do about it. */
export function Notice({
  icon: Icon = FileQuestionIcon,
  title,
  children,
}: {
  icon?: LucideIcon
  title: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2 px-6 py-16 text-center">
      <Icon className="size-5 text-muted-foreground/60" />
      <p className="text-[13px] text-foreground/90">{title}</p>
      {children && (
        <div className="flex max-w-sm flex-col items-center gap-3 font-mono text-[11.5px] text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  )
}

export function Loading() {
  return (
    <div className="min-w-0 flex-1 space-y-2.5 px-4 py-5 md:px-6">
      {[40, 72, 64, 80, 55, 68, 30].map((width) => (
        <Skeleton className="h-3.5" key={width} style={{ width: `${width}%` }} />
      ))}
    </div>
  )
}

/** Highlighted, virtualized code with line numbers, scrolled to and marking `line` when one was asked for. */
export function Code({
  path,
  text,
  line,
  wrap,
}: {
  path: string
  text: string
  line: number | undefined
  wrap: boolean
}) {
  const theme = useStore((state) => state.ui.theme)
  const view = useRef<CodeViewHandle<undefined, undefined>>(null)
  const items = useMemo<CodeViewFileItem[]>(
    () => [{ id: path, type: 'file', file: { name: path, contents: text } }],
    [path, text],
  )
  const options = useMemo<CodeViewReactOptions<undefined, undefined>>(
    () => ({
      theme: { dark: 'vitesse-dark', light: 'vitesse-light' },
      themeType: theme,
      overflow: wrap ? 'wrap' : 'scroll',
      disableFileHeader: true,
      // Highlighting runs on the page's thread: past this many lines it would freeze it for seconds, so they stay plain.
      tokenizeMaxLength: 5000,
      unsafeCSS: themeCss,
    }),
    [theme, wrap],
  )
  // The line stays marked after the scroll, until another file opens.
  const [marked, setMarked] = useState<number>()
  useEffect(() => {
    if (line === undefined) return undefined
    setMarked(line)
    // After the viewer has laid the file out once.
    const frame = requestAnimationFrame(() => {
      view.current?.scrollTo({ type: 'line', id: path, lineNumber: line, align: 'center' })
      reachedTarget()
    })
    return () => cancelAnimationFrame(frame)
  }, [line, path])
  return (
    <CodeView
      className="min-h-0 flex-1 overflow-y-auto"
      items={items}
      key={path}
      options={options}
      ref={view}
      selectedLines={marked ? { id: path, range: { start: marked, end: marked } } : null}
    />
  )
}

/**
 * Relative URLs resolve against file `path` as if the scope were served from this origin: `/` is the scope's root.
 * Streamdown's link hardening needs an origin to keep a bare `notes.md` (it blocks it otherwise), and resolves `../`.
 */
const origin = 'https://scope.invalid'
const baseOf = (path: string) =>
  `${origin}/${path.split('/').slice(0, -1).map(encodeURIComponent).join('/')}/`.replace(
    /\/\/$/,
    '/',
  )

/** `url` as a file in the scope with its `#hash`, or undefined when it points anywhere else. */
function inScope(url: string, base: string) {
  if (url.startsWith('#') || url.startsWith('//')) return undefined
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith(`${origin}/`)) return undefined
  try {
    const parsed = new URL(url, base)
    const path = decodeURIComponent(parsed.pathname.slice(1))
    return parsed.origin === origin && path ? { path, hash: parsed.hash } : undefined
  } catch {
    // Not a URL at all (a stray `%`): Markdown keeps it as written.
    return undefined
  }
}

type Pluggable = NonNullable<StreamdownProps['rehypePlugins']>[number]
const [harden, hardenOptions] = defaultRehypePlugins.harden as [unknown, object]
/** Streamdown's plugins, with links and images resolved against file `path`'s directory. */
const rehypeFor = (path: string) => [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [harden, { ...hardenOptions, defaultOrigin: baseOf(path) }] as Pluggable,
]

/** A heading's anchor as GitHub writes it: `## Write a tool!` → `write-a-tool`. */
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

/** Every relative image a Markdown file shows, `![…](src)` or `<img src>`, as scope paths. */
function imagesIn(path: string, text: string) {
  const paths = [
    ...text.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)/g),
    ...text.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["']/gi),
  ]
    .map((match) => inScope(match[1], baseOf(path))?.path)
    .filter((found) => found !== undefined)
  return [...new Set(paths)].slice(0, 40)
}

/** Each relative image of a Markdown file as a data URL, read through the scope as the file itself was. */
function useImages(conversation: number | undefined, path: string, text: string) {
  const [images, setImages] = useState<{ key: string; urls: Map<string, string> }>()
  const key = `${conversation ?? ''}:${path}`
  useEffect(() => {
    const wanted = imagesIn(path, text)
    if (wanted.length === 0) return undefined
    const controller = new AbortController()
    // oxlint-disable-next-line typescript/no-floating-promises -- each read settles to undefined on failure, so this never rejects.
    void Promise.all(
      wanted.map((source) =>
        api
          .action(
            ReadAction,
            { path: source, ...(conversation !== undefined && { conversation }) },
            { signal: controller.signal },
          )
          .then((file): [string, string] | undefined =>
            file.kind === 'image' ? [source, `data:${file.mime};base64,${file.base64}`] : undefined,
          )
          // A missing or hidden image shows as Markdown shows any broken image.
          .catch(() => undefined),
      ),
    ).then((found) => {
      if (controller.signal.aborted) return
      setImages({ key, urls: new Map(found.filter((item) => item !== undefined)) })
    })
    return () => controller.abort()
  }, [conversation, path, text, key])
  return images?.key === key ? images.urls : undefined
}

/**
 * A Markdown file rendered as a document. Relative links open their file here (the address they carry is shareable),
 * relative images show from the same scope, and anything else is a normal link.
 */
export function Markdown({
  conversation,
  path,
  text,
}: {
  conversation: number | undefined
  path: string
  text: string
}) {
  const images = useImages(conversation, path, text)
  const rehypePlugins = useMemo(() => rehypeFor(path), [path])
  const transform = (url: string, key: string, node: { tagName: string }) => {
    const found = inScope(url, baseOf(path))
    if (!found) return url
    if (node.tagName === 'img' && key === 'src') return images?.get(found.path) ?? ''
    if (key !== 'href') return url
    const hash = found.hash.slice(1)
    const params = new URLSearchParams({ files: found.path })
    if (conversation !== undefined) params.set('scope', String(conversation))
    const line = /^L(\d+)/.exec(hash)?.[1]
    if (line) params.set('line', line)
    return `?${params}`
  }
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      onClickCapture={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        const href = (event.target as Element).closest('a')?.getAttribute('href')
        // A `#heading` link scrolls this document to the heading whose GitHub-style slug it names.
        if (href?.startsWith('#')) {
          event.preventDefault()
          event.stopPropagation()
          const wanted = decodeURIComponent(href.slice(1)).toLowerCase()
          const headings = event.currentTarget.querySelectorAll('h1, h2, h3, h4, h5, h6')
          ;[...headings]
            .find((heading) => slug(heading.textContent ?? '') === wanted)
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          return
        }
        if (!href?.startsWith('?files=')) return
        event.preventDefault()
        event.stopPropagation()
        const params = new URLSearchParams(href)
        const scope = Number(params.get('scope'))
        const line = Number(params.get('line'))
        openFile({
          path: params.get('files') ?? '',
          ...(scope > 0 && { conversation: scope }),
          ...(line > 0 && { line }),
        })
      }}
    >
      <article
        className={cn(
          'mx-auto w-full max-w-[46rem] px-5 pt-6 pb-16 md:px-8 md:pt-8',
          // Prose reads as the conversation's does, with a document's larger headings.
          'text-[15px] leading-[1.65] [&_h1]:!mb-3 [&_h1]:!text-[1.6em] [&_h2]:!mt-8 [&_h2]:!text-[1.3em] [&_h3]:!text-[1.08em] [&_img]:inline',
          '[&_h2]:border-b [&_h2]:border-border/60 [&_h2]:pb-1.5',
        )}
      >
        <MessageResponse
          // Its memo compares only the text: the transform changes with the scope, the file and its images.
          key={`${conversation ?? ''}:${path}:${images?.size ?? -1}`}
          linkSafety={{ enabled: false }}
          rehypePlugins={rehypePlugins}
          urlTransform={transform}
        >
          {text}
        </MessageResponse>
      </article>
    </div>
  )
}

/** An image fitted to the pane's width, on a checkerboard that shows its transparency. */
export function Picture({ file }: { file: Extract<FileContent, { kind: 'image' }> }) {
  const [size, setSize] = useState<string>()
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-auto p-4 md:p-8">
      <img
        alt={file.path}
        className="h-auto max-w-full rounded-sm border border-border/70 bg-[length:16px_16px] bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)]"
        onLoad={(event) =>
          setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)
        }
        src={`data:${file.mime};base64,${file.base64}`}
      />
      {size && <span className="font-mono text-[11px] text-muted-foreground/70">{size}</span>}
    </div>
  )
}
