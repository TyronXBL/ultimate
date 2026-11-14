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

/** The address `?files=<path>&scope=<id>&line=<n>` that opens `at`, as params. */
export function addressOf(at: FileTarget) {
  const params = new URLSearchParams({ files: at.path })
  if (at.conversation !== undefined) params.set('scope', String(at.conversation))
  if (at.line !== undefined) params.set('line', String(at.line))
  return params
}

/** The file an address's params ask for (`addressOf` read back), if they ask for one. */
export function targetOf(params: URLSearchParams): FileTarget | undefined {
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
let requested = targetOf(new URL(location.href).searchParams)
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
    const at =
      surface === 'files' && shown.path !== undefined
        ? addressOf({ path: shown.path, conversation: shown.conversation })
        : new URLSearchParams()
    const same = (name: string) => url.searchParams.get(name) === at.get(name)
    if (same('files') && same('scope')) return
    for (const name of ['files', 'scope', 'line']) url.searchParams.delete(name)
    for (const [name, value] of at) url.searchParams.set(name, value)
    history.replaceState(history.state, '', url)
  }, [surface, shown])
  return null
}
