import { useEffect, useSyncExternalStore } from 'react'
import { useExtensionUiState, useUltimate } from '@/sdk'

/** A file to show: `path` relative to its scope (the project checkout, or `conversation`'s worktree), at `line`. */
export type FileTarget = { conversation?: number; path: string; line?: number }

/** The file on screen, in durable UI state: it survives reloads and follows every tab, as the surface does. */
export const useShown = () =>
  useExtensionUiState<{ conversation?: number; path?: string }>('shown', {})

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const notify = () => {
  for (const listener of listeners) listener()
}

function fromAddress(): FileTarget | undefined {
  const params = new URL(location.href).searchParams
  const path = params.get('files')
  if (!path) return undefined
  const conversation = Number(params.get('scope'))
  const line = Number(params.get('line'))
  return {
    path,
    ...(Number.isSafeInteger(conversation) && conversation > 0 && { conversation }),
    ...(Number.isSafeInteger(line) && line > 0 && { line }),
  }
}

// A file someone asked for and the link has not shown yet: the page's `?files=` first, then `openFile` calls.
let requested = fromAddress()
// The line the surface should scroll to, until it has.
let target: number | undefined

/** Show the Files surface at `at`, scrolled to its line when given. */
export function openFile(at: FileTarget) {
  requested = at
  notify()
}

/** The line the surface was asked to show, until `reachedTarget`. */
export const useTarget = () => useSyncExternalStore(subscribe, () => target)

/** The surface scrolled to the target line, or found it cannot. */
export function reachedTarget() {
  target = undefined
  notify()
}

/**
 * Mounted at the root: shows a requested file, and keeps `?files=<path>&scope=<id>` in the address while Files is on
 * screen, so the address can be shared. It replaces the history entry: switching surfaces adds none.
 */
export function FilesLink() {
  const wanted = useSyncExternalStore(subscribe, () => requested)
  const [shown, setShown] = useShown()
  const { surface, showSurface } = useUltimate()
  useEffect(() => {
    if (wanted === undefined) return
    requested = undefined
    target = wanted.line
    setShown({
      path: wanted.path,
      ...(wanted.conversation !== undefined && { conversation: wanted.conversation }),
    })
    showSurface('files')
    notify()
  }, [wanted, setShown, showSurface])
  useEffect(() => {
    if (requested !== undefined) return
    const url = new URL(location.href)
    const path = surface === 'files' ? (shown.path ?? null) : null
    const scope =
      path === null || shown.conversation === undefined ? null : String(shown.conversation)
    if (url.searchParams.get('files') === path && url.searchParams.get('scope') === scope) return
    for (const name of ['files', 'scope', 'line']) url.searchParams.delete(name)
    if (path !== null) url.searchParams.set('files', path)
    if (scope !== null) url.searchParams.set('scope', scope)
    history.replaceState(history.state, '', url)
  }, [surface, shown])
  return null
}
