/** Ideas in the browser: the project's idea board, each idea launchable into a branch through @ultimate. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** How a launched idea starts: an assessment first, or straight to building. */
export type LaunchSize = 'assess' | 'build'

/** A picture on an idea: base64 data of a PNG, JPEG, WebP or GIF of at most 2 MiB. */
export type IdeaImage = { data: string; mimeType: string }

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
  /** The display-only `ideas.images` entry on conversation 1 holding its pictures (`{ idea, images }`), at most 4. */
  images?: number
  /** When the user parked it; absent while it is on the board. */
  parked?: number
  /**
   * Set when the user launched it; `agents` the branch's own agent setup (`provider/id[:thinking]` by agent) when the
   * user picked one, `branch` once @ultimate linked the branch it started.
   */
  launch?: { size: LaunchSize; at: number; agents?: Record<string, string>; branch?: number }
}

/** `{ next, items }` on conversation 1, oldest first. */
export const IdeasDoc = docRef<{ next: number; items: Idea[] }>('ideas')

/** The `ideas.launch` input a launch posts into @ultimate's conversation, shown there as a card on the user's side. */
export type LaunchEntry = {
  id: number
  title: string
  size: LaunchSize
  agents?: Record<string, string>
}

/** `{ title, notes?, tags?, images? }` → the new idea. User-only; @ultimate uses its `idea` tool. */
export const AddAction = actionRef<
  { title: string; notes?: string; tags?: string[]; images?: IdeaImage[] },
  Idea
>('ideas', 'add')
/** `{ id, title?, notes?, tags?, images? }` → the idea, changed; `images` replaces them all, `[]` removes them. User-only. */
export const UpdateAction = actionRef<
  { id: number; title?: string; notes?: string; tags?: string[]; images?: IdeaImage[] },
  Idea
>('ideas', 'update')
/** `{ id, parked }` → the idea, parked or back on the board. User-only. */
export const ParkAction = actionRef<{ id: number; parked: boolean }, Idea>('ideas', 'park')
/** `{ id }` → `{ id }`; refuses a launched idea. User-only. */
export const RemoveAction = actionRef<{ id: number }, { id: number }>('ideas', 'remove')
/**
 * `{ id, size, agents? }` → the idea, launched: asks @ultimate to start its branch, on the agent setup `agents` when
 * given (extensions/branch-setup). Refuses one already launched. User-only.
 */
export const LaunchAction = actionRef<
  { id: number; size: LaunchSize; agents?: Record<string, string> },
  Idea
>('ideas', 'launch')
