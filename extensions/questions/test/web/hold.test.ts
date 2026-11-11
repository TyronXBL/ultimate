import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { holdAnswer } from '../../hold.tsx'

const page = { visibilityState: 'visible' as DocumentVisibilityState }
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', page)
  page.visibilityState = 'visible'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type Step = 'timer' | 'now' | 'undo' | 'beforeunload' | 'pagehide' | 'hidden' | 'visible'

/** Each run: what happens to an answer held for 3 s, and the sends that go out (`true`: keepalive, on leaving). */
const table: [Step[], boolean[]][] = [
  [['timer'], [false]],
  [['now', 'timer'], [false]],
  [['undo', 'timer', 'beforeunload', 'pagehide'], []],
  // Leaving sends once with keepalive, however many of the page's leave events follow, and the timer then sends nothing.
  [['beforeunload', 'hidden', 'pagehide', 'timer'], [true]],
  [['pagehide', 'timer'], [true]],
  // A phone backgrounding the tab.
  [['hidden', 'timer'], [true]],
  [['visible', 'timer'], [false]],
  [['beforeunload', 'undo', 'now'], [true]],
  [['now', 'undo', 'pagehide'], [false]],
]

it.each(table)('held, then %j sends %j', (steps, expected) => {
  const sends: boolean[] = []
  const held = holdAnswer((keepalive) => sends.push(keepalive), 3000)
  for (const step of steps) {
    if (step === 'timer') vi.advanceTimersByTime(3000)
    else if (step === 'now') held.now()
    else if (step === 'undo') held.undo()
    else if (step === 'hidden' || step === 'visible') {
      page.visibilityState = step
      window.dispatchEvent(new Event('visibilitychange'))
    } else window.dispatchEvent(new Event(step))
  }
  expect(sends).toEqual(expected)
})
