import { useSyncExternalStore } from 'react'

/**
 * How much room the window has. On a `phone` the sidebar and the panel overlay the conversation; on a `tablet` (an
 * unfolded foldable, a narrow window) the sidebar docks beside it and the panel overlays; on a `desktop` both dock.
 * Below `desktop` their open state is the tab's own, so a phone never folds away the desktop's; it starts closed, except
 * a tablet's docked sidebar (`ownDefault` in actions.ts).
 */
export type Viewport = 'phone' | 'tablet' | 'desktop'

let queries: { tablet: MediaQueryList; desktop: MediaQueryList } | undefined
const media = () =>
  (queries ??= {
    tablet: matchMedia('(min-width: 768px)'),
    desktop: matchMedia('(min-width: 1024px)'),
  })

export function viewport(): Viewport {
  const { tablet, desktop } = media()
  return desktop.matches ? 'desktop' : tablet.matches ? 'tablet' : 'phone'
}

function subscribe(listener: () => void) {
  const { tablet, desktop } = media()
  tablet.addEventListener('change', listener)
  desktop.addEventListener('change', listener)
  return () => {
    tablet.removeEventListener('change', listener)
    desktop.removeEventListener('change', listener)
  }
}

export const useViewport = () => useSyncExternalStore(subscribe, viewport)

/** Whether the device types on a touch keyboard, which focusing an input would slide up over the page. */
export const touchKeyboard = () => matchMedia('(pointer: coarse)').matches

/**
 * Sizes the app to the visible part of the page on touch devices. iOS doesn't resize the page for its keyboard (Safari
 * ignores `interactive-widget`): it shrinks the visual viewport and slides the page up, so the title bar left the screen
 * and the page drifted while typing. `--app-height` follows the visual viewport, and the page stays at the top. While
 * pinched in, the app keeps its full height.
 */
export function followVisualViewport() {
  const view = window.visualViewport
  if (!view || !touchKeyboard()) return
  const root = document.documentElement
  const update = () => {
    if (Math.abs(view.scale - 1) > 0.01) root.style.removeProperty('--app-height')
    else root.style.setProperty('--app-height', `${view.height}px`)
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }
  view.addEventListener('resize', update)
  view.addEventListener('scroll', update)
  update()
}

/** Whether `region` overlays the conversation rather than docking beside it. */
export const overlays = (region: 'sidebar' | 'panels', on: Viewport = viewport()) =>
  on === 'phone' || (region === 'panels' && on === 'tablet')
