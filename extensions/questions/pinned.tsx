import { ChevronDownIcon, MessageCircleQuestionIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useState } from 'react'
import { Card, cn, events, formatAgo, useConversation, useDocOf, useNow, useUltimate } from '@/sdk'
import { Address, Body, emptyMessages, MessagesDoc, useAccentOf } from '../messages/ui.tsx'
import type { Message as Waiting } from '../messages/refs.ts'
import { StandingDoc } from '../subagents/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { keyCard, waiting } from './open.tsx'

const gist = (text: string) => text.replace(/\s+/g, ' ').trim()

/** What a row says: how many questions it asks and the first, or the message's own words when it asks none. */
function asks(message: Waiting) {
  const questions = message.questions ?? []
  if (!questions.length) return `asks you · ${gist(message.text)}`
  const count = questions.length === 1 ? '1 question' : `${questions.length} questions`
  return `asks you ${count} · ${gist(questions[0].text)}`
}

/** One message that waits on the user: a line naming who asks and what, and, opened, its text and answer card. */
function Row({
  message,
  open,
  own,
  keys,
  onToggle,
}: {
  message: Waiting
  open: boolean
  /** @ultimate's own message, whose card is in the transcript below: the row shows it there instead. */
  own: boolean
  keys: boolean
  onToggle: () => void
}) {
  const accent = useAccentOf(message.from)
  const now = useNow(60_000)
  const { showSurface, switchConversation } = useUltimate()
  const reveal = () => {
    if (typeof message.from !== 'number') return
    if (message.call)
      events.emit('messages:open', { conversation: message.from, call: message.call })
    showSurface('agent')
    switchConversation(message.from)
  }
  return (
    <div className="border-border/60 not-first:border-t" data-waiting-message={message.id}>
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono max-md:py-1 text-[11px] text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span
          className={cn('flex min-w-0 max-w-24 shrink-0 overflow-hidden sm:max-w-48', accent.name)}
        >
          <Address id={message.from} remote={message.remote} />
        </span>
        <button
          aria-expanded={own ? undefined : open}
          className="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-foreground max-md:min-h-9"
          onClick={own ? reveal : onToggle}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate">{asks(message)}</span>
          <span className="shrink-0 max-sm:hidden">{formatAgo(message.at, now)}</span>
          {own ? (
            <span className="flex shrink-0 items-center gap-1">
              <SquareArrowOutUpRightIcon className="size-3" />
              Show
            </span>
          ) : (
            <ChevronDownIcon
              className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
            />
          )}
        </button>
        {!own && typeof message.from === 'number' && (
          <button
            aria-label="Open where it was asked"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-accent hover:text-foreground max-md:size-9"
            onClick={reveal}
            title="Open where it was asked"
            type="button"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
          </button>
        )}
      </header>
      {open && (
        <div className="max-h-[40dvh] overflow-y-auto overscroll-contain border-t border-border/60 max-md:max-h-[50dvh]">
          <Body text={message.text} />
          <MessageQuestions className="border-t border-border/60" keys={keys} message={message} />
        </div>
      )}
    </div>
  )
}

/**
 * Above @ultimate's composer: every message that waits on the user's answer, newest first, until it is answered or
 * dismissed. A branch's row opens its answer card in place; @ultimate's own row shows its card in the transcript.
 * Other conversations show nothing, so no card is on a page twice.
 */
export function WaitingOnYou() {
  const shown = useConversation((conversation) => conversation.id)
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  const messages = (useDocOf(1, MessagesDoc) ?? emptyMessages).messages
  const [opened, setOpened] = useState<number>()
  if (shown === undefined || shown !== ultimate) return null
  const list = waiting(messages)
  if (!list.length) return null
  // An open card in the strip takes the desktop keys unless one of @ultimate's own cards in the transcript has them.
  const transcriptKeys = keyCard(ultimate, messages) !== undefined
  return (
    <Card attention className="mb-2 overflow-hidden" data-waiting-on-you>
      {list.map((message) => (
        <Row
          key={message.id}
          keys={opened === message.id && !transcriptKeys}
          message={message}
          onToggle={() => setOpened(opened === message.id ? undefined : message.id)}
          open={opened === message.id}
          own={message.from === ultimate}
        />
      ))}
    </Card>
  )
}
