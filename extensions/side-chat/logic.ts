/** Side chat decisions the web facet makes, pure for tests. Browser-safe. */
import type { SideChat, SideChatIndex } from './refs.ts'

/** How a side chat ends: thrown away, or summarized into main. */
export type EndMode = 'discarded' | 'injected'
/** A side chat is open until Discard or Inject starts its ending; a failed inject's summary reopens it. */
type SideLifecycle =
  | { state: 'open' }
  | { state: 'ending'; mode: EndMode }
  | { state: 'ended'; mode: EndMode }
export type EndEvent =
  | { type: 'begin'; mode: EndMode }
  | { type: 'complete' }
  | { type: 'rollback' }

/** The only way a side chat's lifecycle moves; anything else throws. */
export function transition(state: SideLifecycle, event: EndEvent): SideLifecycle {
  switch (event.type) {
    case 'begin':
      if (state.state !== 'open') throw new Error('Side chat is already ended or ending')
      return { state: 'ending', mode: event.mode }
    case 'complete':
      if (state.state !== 'ending') throw new Error('Side chat is not ending')
      return { state: 'ended', mode: state.mode }
    case 'rollback':
      if (state.state !== 'ending' || state.mode !== 'injected')
        throw new Error('Only an inject can roll back')
      return { state: 'open' }
    default:
      return event satisfies never
  }
}
/** Where a side chat stands, from its stored end (on the chat or its index entry) and its Ending's mode. */
export const lifecycleOf = (ended?: EndMode, ending?: EndMode): SideLifecycle =>
  ended
    ? { state: 'ended', mode: ended }
    : ending
      ? { state: 'ending', mode: ending }
      : { state: 'open' }
export const isOpen = (state: SideLifecycle) => state.state === 'open'

/** What a composer key event carries for the Tab toggle. */
export interface TabKey {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
}

/**
 * Whether Tab toggles side chat mode: a bare Tab, typed in @ultimate's own composer (not a side chat's: one level only),
 * while no autocomplete or mention popup claims the key. Shift+Tab stays the thinking level.
 */
export function togglesSideMode(
  event: TabKey,
  where: { conversation?: number; ultimate?: number; popup: boolean },
) {
  return (
    event.key === 'Tab' &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    !where.popup &&
    where.conversation !== undefined &&
    where.conversation === where.ultimate
  )
}

/** Side chats still open, oldest first: ended ones went back to main as a summary or were thrown away. */
export const openSides = (index: Readonly<SideChatIndex> | null | undefined) =>
  (index?.sides ?? []).filter((side) => isOpen(lifecycleOf(side.ended)))

/** The side chat in front, if it is still open; a parked or ended one leaves main in front. */
export const frontSide = (front: number | null, index: SideChatIndex | undefined) =>
  openSides(index).find((side) => side.id === front)

/** An ending in flight and the last failure of one side chat's Discard or Summarize & inject. */
export type Ending = { ending?: 'discard' | 'inject'; error?: string }

/**
 * Endings by side chat id: switching side chats never shows one's failure or spinner on another, and coming back to
 * one whose inject still runs keeps its buttons disabled.
 */
export function createEndings(describe: (failure: unknown) => string) {
  const states = new Map<number, Ending>()
  const listeners = new Set<() => void>()
  const idle: Ending = {}
  const set = (side: number, next: Ending) => {
    states.set(side, next)
    for (const listener of listeners) listener()
  }
  return {
    get: (side: number) => states.get(side) ?? idle,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** Run `call` as side chat `side`'s `how` ending; a failure stays on that side chat as its error. */
    async end(side: number, how: 'discard' | 'inject', call: () => Promise<unknown>) {
      set(side, { ending: how })
      try {
        await call()
        set(side, {})
      } catch (failure) {
        set(side, { error: describe(failure).replace(/^side-chat\/\w+: /, '') })
      }
    },
  }
}

/** How a side chat may end: Discard only while it changed nothing outside itself. */
export function endings(side: Partial<SideChat> | undefined) {
  const live = side?.of !== undefined && isOpen(lifecycleOf(side.ended))
  return { inject: live, discard: live && !side.effects, locked: live && !!side.effects }
}
