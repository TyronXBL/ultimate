/**
 * Previews for other extensions' browser code: the previews `instance` runs (`usePreviews`, refreshed by `Poll` every
 * 5 s and by `refetchPreviews`), the one shown in the frame below the title bar (`useShown`, `show`), and whether this
 * page can frame them at all (`loopback`).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useAction } from '@/sdk'
import { ListAction } from './refs.ts'
import type { Preview } from './refs.ts'

export type { Preview } from './refs.ts'

export const isLoopback = (hostname: string) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)
/** Previews bind to loopback, so a page opened from elsewhere, such as the tailnet, cannot frame them. */
export const loopback = isLoopback(location.hostname)

/**
 * In memory: the previews `list` returned last, which `Poll` asks for, and the preview shown below the title bar at
 * a URL of it. A reload returns to this project.
 */
let previews: Preview[] | undefined
let shown: { preview: Preview; url: string } | undefined
let refetch = () => {}
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Shows `preview` below the title bar, at `url` (its own by default); undefined returns to this project. */
export function show(preview: Preview | undefined, url = preview?.url) {
  shown = preview && url ? { preview, url } : undefined
  changed()
}
/** The preview shown below the title bar and the URL it shows, if any. */
export const useShown = () => useSyncExternalStore(subscribe, () => shown)
/** The previews `list` returned last, running and stopped; undefined until the first answer. */
export const usePreviews = () => useSyncExternalStore(subscribe, () => previews)
/** Asks for the previews now, such as when a menu listing them opens. */
export const refetchPreviews = () => refetch()

/** Asks for the previews every 5 s, for the switcher and preview links; showing one that stopped returns. */
export function Poll() {
  const { data, refetch: again } = useAction(ListAction, null, {
    // A failed poll leaves the last list; the next one tries again.
    onError: () => {},
  })
  useEffect(() => {
    refetch = () => void again()
    const timer = setInterval(refetch, 5000)
    return () => clearInterval(timer)
  }, [again])
  useEffect(() => {
    if (!data) return
    previews = data
    if (shown && !data.some((preview) => preview.running && preview.id === shown?.preview.id))
      shown = undefined
    changed()
  }, [data])
  return null
}
