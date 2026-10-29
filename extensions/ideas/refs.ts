/** Ideas in the browser: the project's idea board, each idea launchable into a branch through @ultimate. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** How a launched idea starts: an assessment first, or straight to building. */
export type LaunchSize = 'assess' | 'build'

/** One idea. Epoch ms throughout. */
export type Idea = {
  id: number
  /** One line, at most 120 characters. */
  title: string
  /** Markdown, at most 4000 characters. */
  notes?: string
  /** Lowercase words without `#`, at most 8. */
  tags: string[]
  by: 'user' | 'ultimate'
  /** Where @ultimate found it, a `#<conversation>/<entry>` breadcrumb. */
  from?: string
  at: number
  /** When the user parked it; absent while it is on the board. */
  parked?: number
  /** Set when the user launched it; `branch` once @ultimate linked the branch it started. */
  launch?: { size: LaunchSize; at: number; branch?: number }
}

/** `{ next, items }` on conversation 1, oldest first. */
export const IdeasDoc = docRef<{ next: number; items: Idea[] }>('ideas')

/** The input a launch posts into @ultimate's conversation, shown there as a card on the user's side. */
export type LaunchEntry = { id: number; title: string; size: LaunchSize }
export const LAUNCH_ENTRY = 'ideas.launch'

/** `{ title, notes?, tags? }` → the new idea. User-only; @ultimate uses its `idea` tool. */
export const AddAction = actionRef<{ title: string; notes?: string; tags?: string[] }, Idea>(
  'ideas',
  'add',
)
/** `{ id, title?, notes?, tags? }` → the idea, changed. User-only. */
export const UpdateAction = actionRef<
  { id: number; title?: string; notes?: string; tags?: string[] },
  Idea
>('ideas', 'update')
/** `{ id, parked }` → the idea, parked or back on the board. User-only. */
export const ParkAction = actionRef<{ id: number; parked: boolean }, Idea>('ideas', 'park')
/** `{ id }` → `{ id }`; refuses a launched idea. User-only. */
export const RemoveAction = actionRef<{ id: number }, { id: number }>('ideas', 'remove')
/** `{ id, size }` → the idea, launched: asks @ultimate to start its branch. Refuses one already launched. User-only. */
export const LaunchAction = actionRef<{ id: number; size: LaunchSize }, Idea>('ideas', 'launch')
