/**
 * Where a message between conversations and the user stands (the messages extension's `Message`), read by structure
 * so server and browser code share one rule. Browser-safe.
 */
type Party = number | 'user' | 'remote'
type Stated = { reply: boolean; state: string }

/** A reply-enabled message still waiting for its answer: on its way or delivered. */
export const isOpen = (message: Stated) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

/** A question to the user that they have neither answered nor dismissed yet. */
export const openQuestion = (message: Stated & { to: Party }) =>
  message.to === 'user' && message.reply && message.state === 'delivered'

/** Conversation `from`'s open question to the user, as a filter. */
export const waitsOnUser = (from: number) => (message: Stated & { from: Party; to: Party }) =>
  message.from === from && openQuestion(message)
