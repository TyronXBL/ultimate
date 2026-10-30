import type { ReactNode } from 'react'
import { api, useConversation } from '@/sdk'
import { OpenFile } from '../coding-tools/ui.tsx'
import type { FileTarget } from './link.tsx'
import { openFile } from './link.tsx'
import { LocateAction } from './refs.ts'

/** A written path and the line its `:12` or `:12-20` suffix names. */
function splitLine(value: string) {
  const match = /:(\d+)(?:-\d+)?$/.exec(value)
  return match
    ? { path: value.slice(0, match.index), line: Number(match[1]) }
    : { path: value, line: undefined }
}

// Extensions a bare file name (no directory) must end in to count as a path, so `item.state` or `v1.2` stays code.
const bareExtensions = new Set(
  'md markdown mdx txt json jsonc yaml yml toml ts tsx mts cts js jsx mjs cjs css html sh bash zsh py rb go rs java kt swift c h cpp hpp sql graphql proto env lock log csv xml svg png jpg jpeg gif webp avif ico'.split(
    ' ',
  ),
)

/**
 * Whether inline code reads as a file path: a name with an extension (any extension once it has a directory, a common
 * one when bare), nothing a path rarely holds (spaces, brackets, quotes, `=`), not a URL or a flag. Conservative: a
 * false positive costs a dead click.
 */
function isFilePath(value: string) {
  const { path } = splitLine(value)
  if (!path || /[\s()[\]{}<>"'`=,;*$|]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) return false
  if (path.startsWith('-')) return false
  const extension = /\.([a-z\d]{1,8})$/i.exec(path.slice(path.lastIndexOf('/') + 1))?.[1]
  if (!extension) return false
  return path.includes('/') || bareExtensions.has(extension.toLowerCase())
}

/** A Markdown href that names a file: a relative or absolute path, not a URL, an anchor or an app link (`/?…`). */
function isFileHref(href: string) {
  if (href.startsWith('//') || href.startsWith('#') || href.startsWith('/?')) return false
  return !/^[a-z][a-z\d+.-]*:/i.test(splitLine(href).path)
}

/** A Markdown href as the path it encodes (`%20` → space); a malformed escape stays as written. */
function decoded(href: string) {
  try {
    return decodeURI(href)
  } catch {
    // Not valid percent-encoding: the href is the path as the author wrote it.
    return href
  }
}

/** Open the file a written path points at: its scope from `locate`, else as written so Files says it is missing. */
function open(target: FileTarget) {
  const line = target.line === undefined ? {} : { line: target.line }
  void api
    .action(LocateAction, { path: target.path, conversation: target.conversation })
    .then((hit) => openFile({ ...(hit ?? target), ...line }))
    .catch(
      // Locating failed (the server is away): open it as written; Files shows why it cannot read it.
      () => openFile(target),
    )
}

function FileButton({ target, children }: { target: FileTarget; children: ReactNode }) {
  return (
    <button
      className="cursor-pointer rounded-sm text-inherit hover:text-brand hover:underline pointer-coarse:py-1.5"
      onClick={() => open(target)}
      title={`Open ${target.path} in Files`}
      type="button"
    >
      {children}
    </button>
  )
}

/** Inline code that reads as a path opens it in Files. */
export function InlineFilePath({ code, core }: { code: string; core: ReactNode }) {
  const conversation = useConversation((current) => current.id)
  if (!isFilePath(code)) return core
  return <FileButton target={{ ...splitLine(code), conversation }}>{core}</FileButton>
}

/** A Markdown link to a path opens it in Files. */
export function FilePathLink({
  href,
  children,
  core,
}: {
  href: string
  children: ReactNode
  core: ReactNode
}) {
  const conversation = useConversation((current) => current.id)
  if (!isFileHref(href)) return core
  return <FileButton target={{ ...splitLine(decoded(href)), conversation }}>{children}</FileButton>
}

/** Files' value for coding-tools' open-file point: the read, write and edit cards' open button. */
export const provideOpenFile = (target: FileTarget) => () => open(target)
export { OpenFile }
