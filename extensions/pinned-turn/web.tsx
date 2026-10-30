import { Shimmer } from '@/components/ai/shimmer'
import {
  api,
  defineWebExtension,
  events,
  TranscriptEntry,
  useConversation,
  useTranscriptScroll,
  useViewport,
} from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { ArrowUpIcon } from 'lucide-react'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { InputsAction } from './refs.ts'

type Turn = { entryId: number; words: string }
/** The newest user turn below `before`, `null` when there is none. */
type Found = { before: number; turn: Turn | null }
/** A page of inputs below `before` being read for a user turn, and the cursor of the page after it. */
type Lookup = { before: number; entries: EntryRecord[]; next?: number }

/**
 * The first phrase of a turn's words, with an ellipsis when they go on: its first sentences up to 20 characters or more,
 * else its first line, so neither "Thanks." nor a list marker such as `1a.` is all it says.
 */
function firstPhrase(words: string) {
  const body = words.trim()
  if (!body) return 'Your message'
  const phrase = /^[^\n]{20,}?[.!?](?=\s)|^[^\n]*/.exec(body)![0].trim()
  return phrase.length < body.length ? `${phrase.replace(/[.!?]$/, '')}…` : phrase
}

/** A user bubble's turn: the row it stands in, its words. */
function turnOf(bubble: Element): Turn {
  return {
    entryId: Number(bubble.closest('[data-entry-id]')!.getAttribute('data-entry-id')),
    words: bubble.getAttribute('data-turn-words')!,
  }
}

/** The newest user bubble among `rows`, newest first; a row such as a folded group can hold several. */
function newestBubble(rows: Element[]) {
  for (const row of rows) {
    const bubble = [...row.querySelectorAll('[data-turn-words]')].at(-1)
    if (bubble) return bubble
  }
  return undefined
}

/**
 * The user turn the top row on screen answers, unless the start of that turn is itself on screen. Without one loaded
 * above, the oldest loaded entry, below which the stored history holds it.
 */
function turnAbove(scroll: HTMLElement, content: HTMLElement): Turn | number | undefined {
  const top = scroll.getBoundingClientRect().top
  const rows = [...content.querySelectorAll(':scope > [data-entry-id]')]
  const first = rows.findIndex((row) => row.getBoundingClientRect().bottom > top)
  if (first < 0) return undefined
  const bubble = newestBubble(rows.slice(0, first + 1).toReversed())
  // A turn scrolled to the top lands a fraction of a pixel above it.
  if (bubble) return bubble.getBoundingClientRect().top >= top - 1 ? undefined : turnOf(bubble)
  if (!content.querySelector(':scope > [data-earlier-history]')) return undefined
  return Math.min(
    ...[...content.querySelectorAll('[data-entry-id]')].map((row) =>
      Number(row.getAttribute('data-entry-id')),
    ),
  )
}

/**
 * While the reader is scrolled up, a line at the top names the user turn being answered; a click goes back to it. On a
 * phone a tap on the words opens them in place, so the reader keeps their place, and the arrow goes back. A turn below
 * the loaded history is found from the stored inputs alone, rendered unseen like their rows to read their words.
 */
function PinnedTurn() {
  const { isAtBottom, scrollRef, contentRef } = useTranscriptScroll()
  const id = useConversation((conversation) => conversation.id)
  const phone = useViewport() === 'phone'
  const [shown, setShown] = useState<Turn | 'earlier'>()
  const [open, setOpen] = useState(false)
  const [lookup, setLookup] = useState<Lookup>()
  const [found, setFound] = useState<Found>()
  const probe = useRef<HTMLDivElement>(null)
  const read = useEffectEvent((before: number, from = before) => {
    api.action(InputsAction, { conversation: id!, before: from }).then(
      (page) => setLookup({ before, entries: page.entries, next: page.before }),
      // Unreadable stored inputs leave this view without a pin below `before`; nothing is retried.
      () => {
        setLookup(undefined)
        setFound({ before, turn: null })
      },
    )
  })
  useLayoutEffect(() => {
    if (!lookup) return
    const bubble = newestBubble([...(probe.current?.children ?? [])])
    if (!bubble && lookup.next !== undefined) {
      read(lookup.before, lookup.next)
      return
    }
    setLookup(undefined)
    setFound({ before: lookup.before, turn: bubble ? turnOf(bubble) : null })
  }, [lookup])
  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (isAtBottom || !scroll || !content || id === undefined) return undefined
    let frame = 0
    let asked: number | undefined
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const above = turnAbove(scroll, content)
        if (typeof above !== 'number') return setShown(above)
        // The turn found below an older `before` is the one below `above` too, unless it is loaded by now.
        const turn = found && above <= found.before ? found.turn : undefined
        if (turn !== undefined && (turn === null || turn.entryId < above))
          return setShown(turn ?? undefined)
        setShown('earlier')
        if (asked === undefined) read((asked = above))
      })
    }
    const scrolled = () => {
      setOpen(false)
      update()
    }
    update()
    scroll.addEventListener('scroll', scrolled, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      scroll.removeEventListener('scroll', scrolled)
      resize.disconnect()
    }
  }, [isAtBottom, scrollRef, contentRef, id, found])
  const turn = isAtBottom ? undefined : shown
  const reveal = (entryId: number) =>
    events.emit('ultimate:reveal-entry', { conversationId: id, entryId })
  return (
    <>
      {lookup && (
        <div hidden ref={probe}>
          {lookup.entries.map((entry) => (
            <div data-entry-id={entry.id} key={entry.id}>
              <TranscriptEntry entry={entry} />
            </div>
          ))}
        </div>
      )}
      {turn && (
        // Rows pass under a short fade, so no line of text shows cut off above the pin.
        <div
          className="-mx-1 animate-in bg-gradient-to-b from-background from-75% to-transparent px-1 pt-2 pb-3 duration-150 fade-in-0 max-md:pt-1.5"
          data-pinned-turn={turn === 'earlier' ? 'earlier' : turn.entryId}
        >
          <div className="pointer-events-auto rounded-lg bg-background shadow-sm">
            {turn === 'earlier' ? (
              <div className="flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-secondary/60 px-3 text-[13px]">
                <ArrowUpIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                <Shimmer className="truncate">finding your message…</Shimmer>
              </div>
            ) : phone ? (
              <div className="rounded-lg border border-border/70 bg-secondary/60">
                <div className="flex items-start">
                  <button
                    aria-expanded={open}
                    className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center py-1.5 pl-3 text-left text-[13px] leading-5 text-foreground/80 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => setOpen((value) => !value)}
                    type="button"
                  >
                    {open ? (
                      <span className="line-clamp-6 break-words whitespace-pre-wrap text-foreground">
                        {turn.words.trim() || firstPhrase(turn.words)}
                      </span>
                    ) : (
                      <span className="truncate">{firstPhrase(turn.words)}</span>
                    )}
                  </button>
                  <button
                    aria-label="Go to your message"
                    className="flex h-8 w-9 shrink-0 cursor-pointer items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => reveal(turn.entryId)}
                    type="button"
                  >
                    <ArrowUpIcon className="size-4" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="group/pin flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-secondary/60 px-3 text-left text-[13px] text-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => reveal(turn.entryId)}
                title="Go to your message"
                type="button"
              >
                <ArrowUpIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/pin:-translate-y-px group-hover/pin:text-foreground" />
                <span className="truncate">{firstPhrase(turn.words)}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default defineWebExtension({
  slots: { 'transcript.top': [PinnedTurn] },
})
