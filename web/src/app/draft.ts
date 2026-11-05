import type { DraftFile, PastedImage } from '@/components/image-paste'
import { storeFiles, storedFiles, storeImages, storedImages } from './draft-images.ts'

/**
 * Where a conversation's composer draft is. `ready`: nothing in flight. `sending`: a submission or a recall of queued
 * input is under way, and the editor is locked. `failed`: the last send, recall or attachment went wrong; the message
 * stays until the next send or recall starts or the attachment is retried, and the draft is kept for retry.
 */
export type Phase = { phase: 'ready' } | { phase: 'sending' } | { phase: 'failed'; error: string }

/**
 * A draft: its content and its phase. `revision` counts edits, so a submission can tell that the draft changed while
 * it was away.
 */
export type Draft = {
  text: string
  images: PastedImage[]
  files: DraftFile[]
  revision: number
  phase: Phase
}

/** What a submission took from the draft, to reconcile with what the draft holds once it ends. */
type Submitted = Pick<Draft, 'text' | 'images' | 'files' | 'revision'>

/**
 * `edit`: typing, a fill, an insert, or a re-read of the stored text. `images`, `files`: attachments change.
 * `fail`: a problem to show, such as a paste that cannot attach (`error` undefined clears it). `send`: a submission or
 * a recall starts. `sent`: the submission was accepted; `stored` is the text storage holds now (another tab may have
 * written it). `unsent`: it failed. `settled`: a recall ended, with its error if it failed.
 */
export type DraftEvent =
  | { type: 'edit'; text: string }
  | { type: 'images'; change: (images: PastedImage[]) => PastedImage[] }
  | { type: 'files'; change: (files: DraftFile[]) => DraftFile[] }
  | { type: 'fail'; error: string | undefined }
  | { type: 'send' }
  | { type: 'sent'; submitted: Submitted; stored: string }
  | { type: 'unsent'; submitted: Submitted; stored: string; error: string }
  | { type: 'settled'; error?: string }

const ready: Phase = { phase: 'ready' }
const settledAs = (error: string | undefined): Phase =>
  error === undefined ? ready : { phase: 'failed', error }

/** The only writer of a draft: what `event` does to `draft` (nothing, when it does not apply). */
export function step(draft: Draft, event: DraftEvent): Draft {
  switch (event.type) {
    case 'edit':
      return { ...draft, text: event.text, revision: draft.revision + 1 }
    case 'images':
      return { ...draft, images: event.change(draft.images), revision: draft.revision + 1 }
    case 'files':
      return { ...draft, files: event.change(draft.files), revision: draft.revision + 1 }
    case 'fail':
      // A problem reported mid-send has nowhere to show: the send ends with its own result.
      return draft.phase.phase === 'sending' ? draft : { ...draft, phase: settledAs(event.error) }
    case 'send':
      return draft.phase.phase === 'sending' ? draft : { ...draft, phase: { phase: 'sending' } }
    case 'sent':
      if (draft.phase.phase !== 'sending') return draft
      return {
        ...draft,
        phase: ready,
        // An edit made while sending stays; so does text another tab stored since.
        text:
          draft.revision !== event.submitted.revision
            ? draft.text
            : event.stored === event.submitted.text
              ? ''
              : event.stored,
        images: draft.images === event.submitted.images ? [] : draft.images,
        files: draft.files === event.submitted.files ? [] : draft.files,
      }
    case 'unsent':
      if (draft.phase.phase !== 'sending') return draft
      return {
        ...draft,
        phase: { phase: 'failed', error: event.error },
        // Unedited text is what storage holds, as a reload would bring it back.
        text: draft.revision === event.submitted.revision ? event.stored : draft.text,
      }
    case 'settled':
      return draft.phase.phase === 'sending' ? { ...draft, phase: settledAs(event.error) } : draft
    default:
      return event satisfies never
  }
}

/** What readers of a draft show and guard on: the editor is locked while `sending`; `error` is the line to show. */
export function view(draft: Draft) {
  return {
    sending: draft.phase.phase === 'sending',
    error: draft.phase.phase === 'failed' ? draft.phase.error : undefined,
    empty: !draft.text.trim() && draft.images.length === 0 && draft.files.length === 0,
    uploading: draft.files.some((file) => !file.path),
  }
}

/** A conversation's draft, kept across editor mounts and mirrored to storage as `step` changes it. */
export function createDraft(id: number | undefined) {
  const key = id === undefined ? undefined : `ultimate.draft.${id}`
  let value: Draft = {
    text: key ? (localStorage.getItem(key) ?? '') : '',
    images: key ? storedImages(key) : [],
    files: key ? storedFiles(key) : [],
    revision: 0,
    phase: ready,
  }
  const listeners = new Set<() => void>()
  return {
    key,
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** The text storage holds now. */
    stored: () => (key ? (localStorage.getItem(key) ?? '') : ''),
    dispatch: (event: DraftEvent) => {
      const before = value
      value = step(before, event)
      if (key) {
        if (value.text !== before.text) {
          if (value.text) localStorage.setItem(key, value.text)
          else localStorage.removeItem(key)
        }
        if (value.images !== before.images) storeImages(key, value.images)
        if (value.files !== before.files) storeFiles(key, value.files)
      }
      for (const listener of listeners) listener()
    },
  }
}
