/**
 * Reloads resume where they left off: when the page goes away it stores what it shows (markup, styles, scroll
 * positions) in `sessionStorage`, `index.html` paints that before any module loads, and it fades out once the app has
 * rendered again (`rendered()`). A core swap, a Vite full reload or F5 so never flash an empty window or the splash.
 */
const key = 'ultimate.resume'
/** The view `index.html` painted from the previous page, until released. */
const shown = document.getElementById('resume')
/** Longest the previous view covers the app, should it never render. */
const deadline = 8000
/**
 * Once the app has rendered, it settles for at most this long, and counts as settled after this long without the
 * transcript growing or scrolling. Timestamps and status text keep changing and do not count.
 */
const settle = 700
const quiet = 120

/**
 * Where the cover is. `covering`: the previous view hides the app, which has not rendered. `settling`: it has, and
 * the cover waits for it to go quiet. `fading`: the cover fades out. `fadingUnrendered`: the same, after the
 * deadline gave up on an app that never rendered. Without a cover the page is `loading` or, rendered, `ready`.
 */
export type Cover =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'covering'; node: HTMLElement }
  | { phase: 'settling'; node: HTMLElement }
  | { phase: 'fading'; node: HTMLElement }
  | { phase: 'fadingUnrendered'; node: HTMLElement }

/** `quiet`: the app stopped changing; `settled`: the settle cap passed; `faded`: the fade ended. */
type Event = 'rendered' | 'quiet' | 'settled' | 'deadline' | 'faded' | 'pagehide'

/** The only writer of the cover's phase: what `event` does in `state` (nothing, when it does not apply). */
export function step(state: Cover, event: Event): Cover {
  switch (state.phase) {
    case 'loading':
      return event === 'rendered' ? { phase: 'ready' } : state
    case 'ready':
      return state
    case 'covering':
      return event === 'rendered'
        ? { phase: 'settling', node: state.node }
        : event === 'deadline'
          ? { phase: 'fadingUnrendered', node: state.node }
          : state
    case 'settling':
      return event === 'quiet' || event === 'settled' || event === 'deadline'
        ? { phase: 'fading', node: state.node }
        : state
    case 'fading':
      return event === 'faded' ? { phase: 'ready' } : state
    case 'fadingUnrendered':
      return event === 'rendered'
        ? { phase: 'fading', node: state.node }
        : event === 'faded'
          ? { phase: 'loading' }
          : state
    default:
      return state satisfies never
  }
}

let state: Cover = shown ? { phase: 'covering', node: shown } : { phase: 'loading' }
/** Ends the watch on the app, while `settling`. */
let stopWatching = () => {}

/** True when this page load painted the previous page's view: a reload, not a fresh start. */
export const resumed = shown !== null
/** True while the previous page's view still covers the app. */
export const covered = () => state.phase === 'covering' || state.phase === 'settling'

const fading = (cover: Cover): cover is Extract<Cover, { node: HTMLElement }> =>
  cover.phase === 'fading' || cover.phase === 'fadingUnrendered'

/** Applies `event`, then does what entering or leaving a phase takes. */
function send(event: Event) {
  const before = state
  state = step(before, event)
  if (event === 'pagehide') return store(state)
  if (before.phase === 'settling' && state.phase !== 'settling') stopWatching()
  if (state.phase === 'settling' && before.phase !== 'settling') stopWatching = watch()
  if (fading(state) && !fading(before)) fade(state.node)
  if (fading(before) && !fading(state)) before.node.remove()
}

/**
 * What `node` shows, for the stored view: elements on screen as they are, each off screen as a blank of its size, so
 * a long transcript stays small and scroll offsets still land. Out-of-flow elements off screen take no room, so they
 * go; hidden ones keep no content.
 */
function copy(node: Node): Node {
  if (!(node instanceof HTMLElement)) return node.cloneNode(true)
  const box = node.getBoundingClientRect()
  if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) {
    const { margin, position } = getComputedStyle(node)
    if (position === 'absolute' || position === 'fixed') return document.createTextNode('')
    const blank = document.createElement('div')
    blank.style.cssText = `width:${box.width}px;height:${box.height}px;margin:${margin};flex:none`
    return blank
  }
  const view = node.cloneNode(false) as HTMLElement
  if (node.scrollTop > 0 || node.scrollLeft > 0)
    view.dataset.resumeScroll = `${node.scrollTop},${node.scrollLeft}`
  // A draft lives in the textarea's value, which markup leaves out.
  if (node instanceof HTMLTextAreaElement) view.textContent = node.value
  else if (node.getClientRects().length > 0 || getComputedStyle(node).display === 'contents')
    for (const child of node.childNodes) view.append(copy(child))
  return view
}

/** The page goes away: stores what the next load resumes from, or nothing when it should start fresh. */
function store(cover: Cover) {
  switch (cover.phase) {
    // Going away again before the app rendered: the previous view is still the one to show, stored as it came.
    case 'covering':
    case 'settling': {
      const stored = sessionStorage.getItem(key)
      if (stored)
        sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(stored), at: Date.now() }))
      return
    }
    // Still loading, under the splash: the next load starts fresh too.
    case 'loading':
    case 'fadingUnrendered':
      sessionStorage.removeItem(key)
      return
    case 'ready':
    case 'fading':
      capture()
  }
}

function capture() {
  const view = document.createElement('div')
  for (const element of document.body.children) {
    if (element.tagName === 'SCRIPT' || element === shown) continue
    if (element.id === 'app') for (const child of element.childNodes) view.append(copy(child))
    else view.append(copy(element))
  }
  const html = view.innerHTML
  const css = [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
    .join('\n')
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), html, css }))
  } catch {
    // Over the storage quota: the next load starts fresh, with the splash.
    sessionStorage.removeItem(key)
  }
}

/** Crossfades the previous view out over the app beneath, which shows the same page by now. */
function fade(node: HTMLElement) {
  sessionStorage.removeItem(key)
  if (document.hidden) send('faded')
  else
    void node
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out' })
      // Cancellation also ends the cover; do not leave its rejected finished promise floating.
      .finished.then(
        () => send('faded'),
        () => send('faded'),
      )
}

/**
 * Watches the app until it has settled: nothing in it was added, removed or scrolled for `quiet` ms (such as the
 * transcript sticking to its bottom as code blocks highlight) or `settle` ms passed. Returns how to stop.
 */
function watch() {
  const app = document.getElementById('app')!
  let timer = setTimeout(() => send('quiet'), quiet)
  const wait = () => {
    clearTimeout(timer)
    timer = setTimeout(() => send('quiet'), quiet)
  }
  const changes = new MutationObserver(wait)
  changes.observe(app, { subtree: true, childList: true })
  addEventListener('scroll', wait, true)
  const cap = setTimeout(() => send('settled'), settle)
  return () => {
    changes.disconnect()
    removeEventListener('scroll', wait, true)
    clearTimeout(timer)
    clearTimeout(cap)
  }
}

/** The app has rendered: a reload from here resumes it, and the previous view uncovers it once it has settled. */
export const rendered = () => send('rendered')

addEventListener('pagehide', () => send('pagehide'))
if (shown) setTimeout(() => send('deadline'), deadline)
