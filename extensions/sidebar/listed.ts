/**
 * The top-level conversations the sidebar lists as rows, roots or branches. `unlisted` are the ones another extension
 * shows elsewhere (the `sidebar.unlisted` point): a side chat is a temporary copy of @ultimate whose fork origin is no
 * branch, so it never shows in In flight, Earlier or Concluded; the side-chat extension nests it under @ultimate
 * instead. Browser-safe.
 */
/**
 * Whether branch `id` is listed In flight: while it is still open (`open`: neither landed since its latest input nor
 * folded away), and also while a question of it waits on the user, so it never folds into Landed before they answer.
 */
export const listedInFlight = (
  id: number,
  open: boolean,
  messages: readonly {
    from: number | 'user' | 'remote'
    to: number | 'user' | 'remote'
    reply: boolean
    state: string
  }[],
) =>
  open ||
  messages.some(
    (message) =>
      message.from === id &&
      message.to === 'user' &&
      message.reply &&
      message.state === 'delivered',
  )

export const topLevelRows = <T extends { id: number; parentConversationId?: number }>(
  conversations: readonly T[],
  unlisted: ReadonlySet<number>,
) =>
  conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined && !unlisted.has(conversation.id),
  )
