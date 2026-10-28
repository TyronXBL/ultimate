/** searxng: `web_search` over the user's own SearXNG instance, and `web_fetch`, a page reader for public addresses. */
import { lookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { Type } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { parse } from 'parse5'
import { Agent, fetch } from 'undici'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { truncateToolOutput } from '../../lib/tool-output.ts'

const DEFAULT_URL = 'http://127.0.0.1:8888'
const SEARCH_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const USER_AGENT = 'Mozilla/5.0 (compatible; Ultimate web_fetch)'
const guidance = `Use web_search to discover pages, verify current facts, or locate documentation. It queries the user's own SearXNG instance, which aggregates public search engines; results may be incomplete when upstream engines are unresponsive, and the tool says which.
Use web_fetch to read a public web page as text, for example a promising search result.
web_fetch refuses localhost and private networks, and reads only HTML and text; use curl for raw files, binary downloads, APIs and local URLs.`

type SearchResult = {
  url: string
  title: string
  snippet: string
  publishedDate: string | null
  domain: string
  engine: string | null
}
type UnresponsiveEngine = { engine: string; message: string }

/** A fault worth a clear tool error; `status` is the remote HTTP answer when there was one; `notify` marks the configuration and connectivity faults worth one process-local notice. */
class WebError extends Error {
  readonly status: number | null
  readonly notify: boolean
  constructor(message: string, options: { status?: number; notify?: boolean } = {}) {
    super(message)
    this.status = options.status ?? null
    this.notify = options.notify ?? false
  }
}

function prettyDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    // A result URL SearXNG produced that no parser reads is still shown as-is.
    return url
  }
}

/** The instance URL, user settings only: a repository must not redirect the user's queries elsewhere. */
async function searxngUrl(host: ExtensionHost): Promise<string> {
  // Invalid settings read as unset (the default); the settings loader reports the file itself.
  const settings = await readSettings(userSettingsPath(host.userHome)).catch((): JsonObject => ({}))
  const group = settings.searxng
  const configured =
    group && typeof group === 'object' && !Array.isArray(group)
      ? (group as Record<string, unknown>).url
      : undefined
  if (configured === undefined) return DEFAULT_URL
  return validated(
    typeof configured === 'string' ? configured : '',
    'searxng.url in ~/.ultimate/settings.json',
  )
}

/** An http(s) URL without credentials, normalized to no trailing slash; names the setting when it is not. */
function validated(value: string, setting: string): string {
  let url: URL | undefined
  try {
    url = new URL(value.trim())
  } catch {
    // Reported below with the setting's name.
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new WebError(
      `web_search needs an http(s) SearXNG URL without credentials: set "${setting}" (for example ${DEFAULT_URL}).`,
      { notify: true },
    )
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Map a SearXNG `/search?format=json` payload to results; anything without a results array is an error. */
function parseResults(payload: unknown, base: string): SearchResult[] {
  const items = (payload as { results?: unknown } | null)?.results
  if (!Array.isArray(items))
    throw new WebError(
      `SearXNG at ${base} returned no results array: is JSON output enabled (search.formats: [html, json] in settings.yml)?`,
    )
  const results: SearchResult[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.url !== 'string' || !/^https?:\/\//i.test(record.url)) continue
    results.push({
      url: record.url,
      title: typeof record.title === 'string' ? record.title : '',
      snippet: typeof record.content === 'string' ? record.content : '',
      publishedDate: nullable(record.publishedDate),
      domain: prettyDomain(record.url),
      engine: nullable(record.engine),
    })
  }
  return results
}

/** SearXNG reports failed engines as [engine, reason] pairs, e.g. [["brave","too many requests"]]. */
function parseUnresponsive(payload: unknown): UnresponsiveEngine[] {
  const items = (payload as { unresponsive_engines?: unknown } | null)?.unresponsive_engines
  if (!Array.isArray(items)) return []
  return items.flatMap((item) =>
    Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string'
      ? [{ engine: item[0], message: item[1] }]
      : [],
  )
}

const nullable = (value: unknown) => (typeof value === 'string' && value ? value : null)

/** Loopback, private, link-local, shared (CGNAT), documentation, multicast and reserved ranges, and the IPv6 forms that embed an IPv4 address (mapped, NAT64, 6to4). */
const nonPublic = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv6')

/** IPv4-mapped IPv6 is refused by its prefix: a BlockList subnet for it would match every IPv4 address too. */
const isPublic = (address: string) => {
  const family = isIP(address)
  if (family === 0 || (family === 6 && /^::ffff:/i.test(address))) return false
  return !nonPublic.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** Every address a name resolves to must be public; checked when connecting, so DNS rebinding cannot slip past it. */
function publicLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, '')
    const refused = addresses.find((address) => !isPublic(address.address))
    if (refused)
      return callback(
        new WebError(
          `web_fetch refuses ${hostname}: it resolves to ${refused.address}, which is not a public address.`,
        ),
        '',
      )
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

/** A URL web_fetch may request: http(s), no credentials, and no non-public IP literal (names are checked on connect). */
function fetchable(value: string, base?: URL): URL {
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    throw new WebError(`web_fetch needs an absolute http(s) URL, not "${value}".`)
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new WebError(`web_fetch reads http(s) URLs only, not ${url.protocol}.`)
  if (url.username || url.password)
    throw new WebError('web_fetch refuses URLs with credentials in them.')
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) && !isPublic(literal))
    throw new WebError(`web_fetch refuses ${url.host}: it is not a public address.`)
  return url
}

/** The WebError behind a failed fetch: undici wraps the lookup's error as the cause of its own. */
function cause(error: unknown): WebError | undefined {
  for (let current = error; current instanceof Error; current = current.cause)
    if (current instanceof WebError) return current
  return undefined
}

type Node = {
  nodeName: string
  tagName?: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
}
const skipped = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'canvas',
  'select',
  'button',
  'nav',
  'footer',
])
const blocks = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'aside',
  'blockquote',
  'figure',
  'figcaption',
  'table',
  'tr',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
])

/** Hidden or navigation markup, by its attributes rather than its tag. */
const hidden = (node: Node) =>
  node.attrs?.some(
    ({ name, value }) =>
      name === 'hidden' ||
      (name === 'aria-hidden' && value === 'true') ||
      (name === 'role' && (value === 'navigation' || value === 'search')),
  ) ?? false

/** The first element, depth first, that `match` accepts. */
function find(node: Node, match: (node: Node) => boolean): Node | undefined {
  if (match(node)) return node
  for (const child of node.childNodes ?? []) {
    const found = find(child, match)
    if (found) return found
  }
  return undefined
}
const isMain = (node: Node) =>
  node.tagName === 'main' ||
  (node.attrs?.some((attr) => attr.name === 'role' && attr.value === 'main') ?? false)

/** HTML as markdown-ish text: headings, paragraphs, list items, absolute links and verbatim `pre`; only the main content when the page marks it. */
function htmlToText(html: string, base: string): { title: string; text: string } {
  const textOf = (node: Node): string =>
    node.nodeName === '#text' ? (node.value ?? '') : (node.childNodes ?? []).map(textOf).join('')
  const inner = (node: Node) => (node.childNodes ?? []).map(render).join('')
  function render(node: Node): string {
    if (node.nodeName === '#text') return (node.value ?? '').replace(/\s+/g, ' ')
    const tag = node.tagName
    // The document, comments and doctypes: only their children (comments have none) count.
    if (!tag) return inner(node)
    if (tag === 'head' || skipped.has(tag) || hidden(node)) return ''
    if (tag === 'pre') return `\n\n\`\`\`\n${textOf(node).replace(/\n+$/, '')}\n\`\`\`\n\n`
    const heading = /^h([1-6])$/.exec(tag)
    if (heading) return `\n\n${'#'.repeat(Number(heading[1]))} ${inner(node).trim()}\n\n`
    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n\n---\n\n'
    if (tag === 'li') return `\n- ${inner(node).trim()}\n`
    if (tag === 'code') return `\`${textOf(node)}\``
    if (tag === 'td' || tag === 'th') return `${inner(node).trim()} | `
    const text = inner(node)
    if (tag === 'a') {
      const label = text.trim()
      const href = node.attrs?.find((attr) => attr.name === 'href')?.value
      const target = label && href && !href.startsWith('#') ? absolute(href, base) : undefined
      return target ? text.replace(label, () => `[${label}](${target})`) : text
    }
    return blocks.has(tag) ? `\n\n${text.trim()}\n\n` : text
  }
  const document = parse(html) as Node
  const titled = find(document, (node) => node.tagName === 'title')
  const title = titled ? textOf(titled).replace(/\s+/g, ' ').trim() : ''
  const raw = render(find(document, isMain) ?? document)
  // Tidy the whitespace between blocks, but leave fenced `pre` content as it was.
  const text = raw
    .split(/(\n```\n[\s\S]*?\n```\n)/)
    .map((part, index) =>
      index % 2 ? part : part.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' '),
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

function absolute(href: string, base: string) {
  try {
    const url = new URL(href, base)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    // An unparsable href stays plain text.
    return undefined
  }
}

/** The body as text, at most MAX_BODY_BYTES of it, in the charset the response names. */
async function body(response: Awaited<ReturnType<typeof fetch>>, contentType: string) {
  const chunks: Uint8Array[] = []
  let size = 0
  let cut = false
  for await (const chunk of response.body ?? []) {
    chunks.push(chunk)
    size += chunk.length
    if (size >= MAX_BODY_BYTES) {
      cut = true
      break
    }
  }
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8'
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    // An unknown charset label: UTF-8 is the web's default and reads most pages.
    decoder = new TextDecoder()
  }
  return { text: decoder.decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES)), cut }
}

export default function searxng(host: ExtensionHost) {
  // Unreachable or misconfigured instance: a tool error every call, one process-local notice ever.
  const notices = host.resource('searxng:notice', () => ({ sent: false }))
  const agent = host.resource('searxng:fetch-agent', () => {
    const created = new Agent({ connect: { lookup: publicLookup } })
    host.onClose(() => created.close())
    return created
  })

  async function search(
    query: string,
    options: { signal?: AbortSignal; categories?: string; time_range?: string },
  ) {
    const base = await searxngUrl(host)
    const url = new URL(`${base}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (options.categories) url.searchParams.set('categories', options.categories)
    if (options.time_range) url.searchParams.set('time_range', options.time_range)
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    try {
      response = await globalThis.fetch(url, { headers: { accept: 'application/json' }, signal })
    } catch {
      if (options.signal?.aborted) throw new WebError('web_search was cancelled.')
      throw new WebError(
        timeout.aborted
          ? `SearXNG at ${base} did not answer within ${SEARCH_TIMEOUT_MS / 1000} seconds.`
          : `Could not reach SearXNG at ${base}; is it running? The URL is searxng.url in ~/.ultimate/settings.json.`,
        { notify: true },
      )
    }
    // An unreadable body reads as empty; the status below still says what happened.
    const text = await response.text().catch(() => '')
    if (response.status === 403 && /format json is not supported/i.test(text))
      throw new WebError(
        `SearXNG at ${base} refuses JSON output (HTTP 403). Enable it there: search.formats: [html, json] in settings.yml.`,
        { status: 403, notify: true },
      )
    if (!response.ok)
      throw new WebError(
        `SearXNG at ${base} answered HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : '.'}`,
        { status: response.status },
      )
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new WebError(`SearXNG at ${base} returned a response that is not JSON.`)
    }
    return { results: parseResults(payload, base), unresponsive: parseUnresponsive(payload) }
  }

  async function read(address: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let url = fetchable(address)
    /** A failed request or body read as the tool reports it: cancelled, timed out, refused or unreachable. */
    const failed = (error: unknown) => {
      if (signal?.aborted) return new WebError('web_fetch was cancelled.')
      if (timeout.aborted)
        return new WebError(`${url.host} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.`)
      return (
        cause(error) ??
        new WebError(`Could not fetch ${url.href}: ${String((error as Error).cause ?? error)}`)
      )
    }
    for (let hops = 0; ; hops++) {
      let response: Awaited<ReturnType<typeof fetch>>
      try {
        response = await fetch(url, {
          dispatcher: agent,
          redirect: 'manual',
          signal: combined,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
        })
      } catch (error) {
        throw failed(error)
      }
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        // Only the redirect's target matters; its body is discarded unread.
        await response.body?.cancel().catch(() => {})
        if (hops >= MAX_REDIRECTS)
          throw new WebError(`${address} redirected more than ${MAX_REDIRECTS} times.`)
        url = fetchable(location, url)
        continue
      }
      const contentType = response.headers.get('content-type') ?? ''
      const mime = contentType.split(';')[0].trim().toLowerCase()
      if (!response.ok) {
        // Error pages are not read: the status is the answer.
        await response.body?.cancel().catch(() => {})
        throw new WebError(`${url.href} answered HTTP ${response.status}.`, {
          status: response.status,
        })
      }
      const html = mime === 'text/html' || mime === 'application/xhtml+xml'
      const textual =
        mime === '' ||
        mime.startsWith('text/') ||
        /^application\/([\w.-]+\+)?(json|xml)$/.test(mime)
      if (!html && !textual) {
        // A binary body is not downloaded.
        await response.body?.cancel().catch(() => {})
        throw new WebError(
          `web_fetch reads HTML and text; ${url.href} is ${mime}. Use curl for files like this.`,
        )
      }
      const { text, cut } = await body(response, contentType).catch((error: unknown) => {
        throw failed(error)
      })
      const page = html ? htmlToText(text, url.href) : { title: '', text }
      return { ...page, finalUrl: url.href, contentType: mime, cut }
    }
  }

  /** A tool failure: one notice for configuration faults, the error in text and details. */
  async function failure(
    error: unknown,
    fallback: string,
    details: (value: JsonObject) => Promise<void>,
  ) {
    if (error instanceof WebError && error.notify && !notices.sent) {
      notices.sent = true
      host.notice(`web_search: ${error.message}`)
    }
    const text = truncateToolOutput(error instanceof Error ? error.message : fallback)
    await details({
      status: 'error',
      error: text,
      httpStatus: error instanceof WebError ? error.status : null,
    })
    return { isError: true, output: [{ type: 'text' as const, text }] }
  }

  return defineExtension({
    name: 'searxng',
    sections: [section('web_tools', () => guidance)],
    tools: [
      defineTool({
        name: 'web_search',
        // Repeating a search only reads public web results; it changes no project state.
        replay: 'safe',
        description:
          "Search the public web through the user's own SearXNG instance. Returns ranked pages with titles, URLs, domains, snippets and publication dates, plus a note when upstream engines were unresponsive. Use this to discover sources or find current information; read a result with web_fetch. Output is limited to 50KB or 2,000 lines.",
        parameters: Type.Object({
          query: Type.String({
            minLength: 1,
            maxLength: 512,
            description: 'What to find on the web, as a self-contained search query.',
          }),
          count: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 25,
              description: 'Maximum number of results. Defaults to 10.',
            }),
          ),
          categories: Type.Optional(
            Type.String({
              maxLength: 128,
              description:
                'Comma-separated SearXNG categories, for example "general", "news", "it". Defaults to the instance default.',
            }),
          ),
          time_range: Type.Optional(
            Type.Union(
              [
                Type.Literal('day'),
                Type.Literal('week'),
                Type.Literal('month'),
                Type.Literal('year'),
              ],
              { description: 'Only results from this recent period.' },
            ),
          ),
        }),
        async execute(args, api, context) {
          try {
            const { results, unresponsive } = await search(args.query, {
              signal: context.abortSignal,
              categories: args.categories,
              time_range: args.time_range,
            })
            const shown = results.slice(0, args.count ?? 10)
            await api.details({ status: 'success', results: shown, unresponsive }, context)
            const note = unresponsive.length
              ? `\n\nNote: ${unresponsive.length} upstream ${unresponsive.length === 1 ? 'engine was' : 'engines were'} unresponsive (${unresponsive.map((engine) => `${engine.engine}: ${engine.message}`).join('; ')}); the result set may be incomplete.`
              : ''
            const list = shown
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title || result.url}\nURL: ${result.url}${result.publishedDate ? `\nPublished: ${result.publishedDate}` : ''}\n${result.snippet}`,
              )
              .join('\n\n---\n\n')
            const text = shown.length
              ? `Found ${shown.length} results for: ${args.query}\n\n${list}${note}`
              : `No results for: ${args.query}${note}`
            return { output: [{ type: 'text', text: truncateToolOutput(text) }] }
          } catch (error) {
            return failure(error, 'web_search failed.', (value) => api.details(value, context))
          }
        },
      }),
      defineTool({
        name: 'web_fetch',
        // Repeating a fetch only reads a public page; it changes no project state.
        replay: 'safe',
        description:
          'Read one public web page as text: HTML becomes markdown-like text (headings, paragraphs, lists, links); plain text and JSON come back as they are. Refuses localhost and private networks, and binary content. Output is limited to 50KB or 2,000 lines.',
        parameters: Type.Object({
          url: Type.String({ minLength: 1, description: 'The http(s) URL of the page.' }),
          max_chars: Type.Optional(
            Type.Integer({
              minimum: 100,
              description: 'Return at most this many characters of the page text.',
            }),
          ),
        }),
        async execute(args, api, context) {
          try {
            const page = await read(args.url, context.abortSignal)
            const shortened = args.max_chars !== undefined && page.text.length > args.max_chars
            const content = truncateToolOutput(
              shortened ? page.text.slice(0, args.max_chars) : page.text,
            )
            const truncated = page.cut || shortened || content !== page.text
            await api.details(
              {
                status: 'success',
                url: args.url,
                finalUrl: page.finalUrl,
                title: page.title,
                contentType: page.contentType,
                content,
                truncated,
              },
              context,
            )
            const header = `${page.title ? `# ${page.title}\n` : ''}URL: ${page.finalUrl}${truncated ? '\n(The page is longer than shown.)' : ''}`
            return {
              output: [{ type: 'text', text: truncateToolOutput(`${header}\n\n${content}`) }],
            }
          } catch (error) {
            return failure(error, 'web_fetch failed.', (value) => api.details(value, context))
          }
        },
      }),
    ],
  })
}
