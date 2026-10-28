/** searxng's transcript cards: search shows the query, top domains and result count; fetch the page and its text. Failures open themselves. */
import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { defineWebExtension, formatBytes, plural, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

/** One result in web_search's `details` (server.ts); the optional fields are absent from parallel's results. */
interface Result {
  url: string
  title: string | null
  snippet?: string
  publishedDate?: string | null
  domain?: string
}
interface Unresponsive {
  engine: string
  message: string
}
type Failure = { status: 'error'; error: string; httpStatus: number | null }
type SearchDetails =
  | { status: 'success'; results?: Result[]; unresponsive?: Unresponsive[] }
  | Failure
type FetchDetails =
  | {
      status: 'success'
      url: string
      finalUrl: string
      title: string
      contentType: string
      content: string
      truncated: boolean
    }
  | Failure

const text = (value: unknown) => (typeof value === 'string' ? value : '')
/** A URL as shown: no scheme, no `www.`, no trailing slash. */
const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
const day = (date: string) => (/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date)
/** Fetched text must not load anything from the web: no images. */
const offline = ['img', 'picture', 'source']
function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // Shown as given when no parser reads it.
    return url
  }
}
/** The first few distinct domains, in rank order. */
function domains(results: readonly Result[], count = 3) {
  const unique = [...new Set(results.map((result) => result.domain ?? host(result.url)))]
  return unique.length > count
    ? `${unique.slice(0, count).join(', ')} +${unique.length - count}`
    : unique.join(', ')
}

/** The card both tools share: collapsed while it goes well, opened by a failure, also one that arrives live. */
function Card({
  call,
  name,
  title,
  meta,
  running,
  children,
}: {
  call: ToolCallView
  name: string
  title: ReactNode
  meta: ReactNode
  running: string
  children: ReactNode
}) {
  const duration = useToolDuration(call)
  const details = call.details as Failure | { status: 'success' } | undefined
  const failure = details?.status === 'error' ? details : undefined
  const failed = call.status === 'error' || !!failure
  const [open, setOpen] = useState(failed)
  const was = useRef(failed)
  useEffect(() => {
    if (failed && !was.current) setOpen(true)
    was.current = failed
  }, [failed])
  return (
    <Tool onOpenChange={setOpen} open={open}>
      <ToolHeader
        meta={
          <>
            {meta}
            {duration && <span>{duration}</span>}
          </>
        }
        name={name}
        state={call.status}
        title={title}
      />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">{running}</Shimmer>
          </ToolSection>
        )}
        {failure ? (
          <ToolSection>
            <div className="break-words text-error">{failure.error}</div>
            {failure.httpStatus && (
              <div className="text-[11px] text-muted-foreground/70">HTTP {failure.httpStatus}</div>
            )}
          </ToolSection>
        ) : details ? (
          children
        ) : (
          call.status === 'error' && <ToolOutput isError output={call.output} />
        )}
        <ToolDiagnostics
          diagnostics={call.diagnostics.filter((item) => item.code !== 'tool_error')}
        />
      </ToolContent>
    </Tool>
  )
}

/** A link that opens in a new tab; nothing is requested until it is followed. */
function Link({
  url,
  className,
  children,
}: {
  url: string
  className?: string
  children: ReactNode
}) {
  return (
    <a className={className} href={url} rel="noreferrer" target="_blank" title={url}>
      {children}
    </a>
  )
}

function Search({ call }: { call: ToolCallView }) {
  const details = call.details as SearchDetails | undefined
  // `?? []`: a call made while `parallel` provided web_search has its own details shape.
  const results = (details?.status === 'success' && details.results) || []
  const unresponsive = (details?.status === 'success' && details.unresponsive) || []
  return (
    <Card
      call={call}
      meta={
        <>
          {unresponsive.length > 0 && (
            <span className="text-warning">{plural(unresponsive.length, 'engine')} down</span>
          )}
          {details?.status === 'success' && <span>{plural(results.length, 'result')}</span>}
        </>
      }
      name="web_search"
      running="searching the web…"
      title={
        <>
          <span className="text-foreground/90">{text(call.args.query)}</span>
          {results.length > 0 && (
            <span className="text-muted-foreground/60"> · {domains(results)}</span>
          )}
        </>
      }
    >
      {results.length > 0 && (
        <ol aria-label="Search results" className="divide-y divide-border/60">
          {results.map((result, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Results have no id and the same URL may repeat.
            <li className="flex gap-2.5 px-2.5 py-2" key={index}>
              <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  className="block truncate font-sans text-[13px] text-foreground hover:underline"
                  url={result.url}
                >
                  {result.title || bare(result.url)}
                </Link>
                <div className="mt-0.5 flex min-w-0 gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate">{result.domain ?? host(result.url)}</span>
                  {result.publishedDate && (
                    <span className="shrink-0 text-muted-foreground/70">
                      {day(result.publishedDate)}
                    </span>
                  )}
                </div>
                {result.snippet && (
                  <p className="mt-1 line-clamp-3 font-sans text-[12.5px] leading-snug text-muted-foreground">
                    {result.snippet}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {details?.status === 'success' && results.length === 0 && (
        <ToolSection className="text-muted-foreground/70">no results</ToolSection>
      )}
      {unresponsive.length > 0 && (
        <ToolSection className="border-t border-border/60 text-[11.5px]">
          {unresponsive.map((engine, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- An engine may report more than one failure.
            <div className="flex min-w-0 gap-1.5 text-warning" key={index}>
              <span className="shrink-0">!</span>
              <span className="min-w-0 break-words">
                {engine.engine}: {engine.message}
              </span>
            </div>
          ))}
        </ToolSection>
      )}
    </Card>
  )
}

function Fetch({ call }: { call: ToolCallView }) {
  const details = call.details as FetchDetails | undefined
  // A call made while `parallel` provided web_fetch has no `finalUrl`: it shows the tool's text output instead.
  const page =
    details?.status === 'success' && typeof details.finalUrl === 'string' ? details : undefined
  const url = page?.finalUrl ?? text(call.args.url)
  const size = page ? new TextEncoder().encode(page.content).length : 0
  return (
    <Card
      call={call}
      meta={
        page && (
          <span>
            {formatBytes(size)}
            {page.truncated && ' · truncated'}
          </span>
        )
      }
      name="web_fetch"
      running="reading the page…"
      title={<span className="text-foreground/90">{bare(url)}</span>}
    >
      {!page && call.status !== 'running' && <ToolOutput output={call.output} />}
      {page && (
        <div className="px-2.5 py-2">
          <div className="truncate font-sans text-[13px] text-foreground">
            {page.title || bare(page.finalUrl)}
          </div>
          <Link
            className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            url={page.finalUrl}
          >
            <span className="truncate">{bare(page.finalUrl)}</span>
            <ExternalLinkIcon className="size-3 shrink-0" />
          </Link>
          {page.content && (
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1 rounded-sm text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
                <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                {page.contentType || 'content'}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1.5 max-h-96 overflow-y-auto rounded-sm border border-border/70 bg-background px-3 py-2 font-sans">
                  {/html/.test(page.contentType) ? (
                    <MessageResponse
                      className="text-[13px] leading-relaxed"
                      disallowedElements={offline}
                    >
                      {page.content}
                    </MessageResponse>
                  ) : (
                    <pre className="font-mono text-[12px] whitespace-pre-wrap break-words">
                      {page.content}
                    </pre>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}
    </Card>
  )
}

export default defineWebExtension({ tools: { web_search: Search, web_fetch: Fetch } })
