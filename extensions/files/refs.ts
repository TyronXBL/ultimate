/** Files in the browser: the scopes to read from, their file lists and one file's contents. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * Where files are read from: the project checkout (`conversation` absent, labelled by its branch, usually `main`), or
 * the working tree of conversation `conversation`'s ready worktree. Uncommitted files show as they are on disk.
 */
export type FileScope = {
  conversation?: number
  /** The checkout's branch (`main`, `ultimate/…`). */
  branch: string
  /** The conversation's title for a worktree; absent for the project checkout. */
  title?: string
}

/** One file read: text (Markdown and code), an image as base64, or another binary file by its size only. */
export type FileContent = {
  /** Relative to the scope's root, `/`-separated. */
  path: string
  /** Bytes on disk. */
  size: number
} & (
  | {
      kind: 'text'
      text: string
      /** Longer than 2 MB: `text` holds the first 2 MB. */ truncated?: boolean
    }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'binary' }
)

/** No arguments → the project checkout first, then every ready worktree, newest first. */
export const ScopesAction = actionRef<null, FileScope[]>('files', 'scopes')

/**
 * `{ conversation? }` → the files of that scope as Git lists them (tracked, and untracked but not ignored), sorted,
 * without the ones whose names may hold secrets. Throws when the conversation has no ready worktree.
 */
export const TreeAction = actionRef<{ conversation?: number }, { files: string[] }>('files', 'tree')

/**
 * `{ conversation?, path }` → the file at relative `path` in that scope. Throws, with a message the viewer shows, on
 * a path Git does not list there, a name that may hold secrets, a path (or symlink) resolving outside the scope, and
 * an image over 10 MB.
 */
export const ReadAction = actionRef<{ conversation?: number; path: string }, FileContent>(
  'files',
  'read',
)

/**
 * `{ path, conversation? }` → the scope a path written in conversation `conversation` points at, or null. An absolute
 * path maps to the scope whose root contains it. A relative one is tried in that conversation's worktree, then the
 * project checkout, then every other ready worktree; the first that lists it wins.
 */
export const LocateAction = actionRef<
  { path: string; conversation?: number },
  { conversation?: number; path: string } | null
>('files', 'locate')
