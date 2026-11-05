import { describe, expect, it, vi } from 'vitest'
import { createDraft, step } from '../../web/src/app/draft.ts'
import type { Draft, DraftEvent, Phase } from '../../web/src/app/draft.ts'

const image = { data: 'aGk=', mimeType: 'image/png' }
const file = { id: 'f1', name: 'a.txt', size: '1 B', mimeType: 'text/plain', path: '/up/a.txt' }

const ready: Phase = { phase: 'ready' }
const sending: Phase = { phase: 'sending' }
const failed = (error: string): Phase => ({ phase: 'failed', error })

function draft(change: Partial<Draft> = {}): Draft {
  return { text: 'hello', images: [], files: [], revision: 3, phase: ready, ...change }
}

/** What a submission takes: the draft as it was when sending began. */
const submitted = (from: Draft) => ({
  text: from.text,
  images: from.images,
  files: from.files,
  revision: from.revision,
})

describe('step', () => {
  const images = [image]
  const files = [file]
  const full = draft({ images, files })
  const rows: [string, Draft, DraftEvent, Partial<Draft>][] = [
    ['send from ready', draft(), { type: 'send' }, { phase: sending }],
    [
      'send from failed clears the error',
      draft({ phase: failed('x') }),
      { type: 'send' },
      { phase: sending },
    ],
    [
      'send while sending is ignored',
      draft({ phase: sending }),
      { type: 'send' },
      { phase: sending },
    ],
    [
      'sent clears the text when nothing changed and storage still holds it',
      draft({ phase: sending }),
      { type: 'sent', submitted: submitted(draft()), stored: 'hello' },
      { text: '', phase: ready },
    ],
    [
      'sent keeps an edit made while sending',
      draft({ phase: sending, text: 'hello again', revision: 4 }),
      { type: 'sent', submitted: submitted(draft()), stored: 'hello again' },
      { text: 'hello again', revision: 4, phase: ready },
    ],
    [
      'sent keeps the text another tab stored meanwhile',
      draft({ phase: sending }),
      { type: 'sent', submitted: submitted(draft()), stored: 'from other tab' },
      { text: 'from other tab', phase: ready },
    ],
    [
      'sent clears images and files when unchanged',
      { ...full, phase: sending },
      { type: 'sent', submitted: submitted(full), stored: 'hello' },
      { text: '', images: [], files: [], phase: ready },
    ],
    [
      'sent keeps images and files that were replaced while sending',
      { ...full, phase: sending, images: [...images, image], files: [...files], revision: 4 },
      { type: 'sent', submitted: submitted(full), stored: 'hello' },
      { images: [image, image], files: [file], phase: ready },
    ],
    [
      'unsent keeps the draft and shows the error',
      { ...full, phase: sending },
      { type: 'unsent', submitted: submitted(full), stored: 'hello', error: 'offline' },
      { phase: failed('offline') },
    ],
    [
      'unsent reads unedited text back from storage',
      draft({ phase: sending }),
      { type: 'unsent', submitted: submitted(draft()), stored: 'hello (older tab)', error: 'x' },
      { text: 'hello (older tab)', phase: failed('x') },
    ],
    [
      'unsent keeps an edit made while sending',
      draft({ phase: sending, text: 'edited', revision: 4 }),
      { type: 'unsent', submitted: submitted(draft()), stored: 'hello', error: 'x' },
      { text: 'edited', phase: failed('x') },
    ],
    [
      'settled after a recall is ready',
      draft({ phase: sending }),
      { type: 'settled' },
      { phase: ready },
    ],
    [
      'settled after a failed recall shows the error',
      draft({ phase: sending }),
      { type: 'settled', error: 'gone' },
      { phase: failed('gone') },
    ],
    [
      'sent outside a send is ignored',
      draft(),
      { type: 'sent', submitted: submitted(draft()), stored: 'hello' },
      {},
    ],
    [
      'unsent outside a send is ignored',
      draft(),
      { type: 'unsent', submitted: submitted(draft()), stored: 'x', error: 'late' },
      {},
    ],
    ['settled outside a send is ignored', draft(), { type: 'settled', error: 'late' }, {}],
    [
      'an attach error shows',
      draft(),
      { type: 'problem', error: 'Images stay here: remove them to send elsewhere' },
      { phase: failed('Images stay here: remove them to send elsewhere') },
    ],
    [
      'a new attach clears the error',
      draft({ phase: failed('x') }),
      { type: 'problem', error: undefined },
      { phase: ready },
    ],
    [
      'an error mid-send has nowhere to show',
      draft({ phase: sending }),
      { type: 'problem', error: 'x' },
      {},
    ],
    [
      'an edit while failed keeps the error',
      draft({ phase: failed('x') }),
      { type: 'edit', text: 'more' },
      { text: 'more', revision: 4, phase: failed('x') },
    ],
    [
      'an edit counts a revision',
      draft(),
      { type: 'edit', text: 'new' },
      { text: 'new', revision: 4 },
    ],
    [
      'attaching images counts a revision',
      draft(),
      { type: 'images', change: (current) => [...current, image] },
      { images: [image], revision: 4 },
    ],
    [
      'attaching files counts a revision',
      draft(),
      { type: 'files', change: (current) => [...current, file] },
      { files: [file], revision: 4 },
    ],
  ]
  it.each(rows)('%s', (_name, before, event, change) => {
    expect(step(before, event)).toEqual({ ...before, ...change })
  })
})

describe('storage mirror', () => {
  it('writes the text as it is edited and sent, also over another tab’s', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    try {
      const held = createDraft(7)
      held.dispatch({ type: 'edit', text: 'hello' })
      expect(stored.get('ultimate.draft.7')).toBe('hello')
      held.dispatch({ type: 'edit', text: '' })
      expect(stored.has('ultimate.draft.7')).toBe(false)

      // Another tab stores its own text; filling this tab's current text again must win over it.
      held.dispatch({ type: 'edit', text: 'hello' })
      stored.set('ultimate.draft.7', 'other')
      held.dispatch({ type: 'edit', text: 'hello' })
      expect(stored.get('ultimate.draft.7')).toBe('hello')

      held.dispatch({ type: 'send' })
      held.dispatch({ type: 'sent', submitted: held.get(), stored: held.stored() })
      expect(held.get().text).toBe('')
      expect(stored.has('ultimate.draft.7')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
