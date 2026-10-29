import { ImagePlusIcon, PlusIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { cn, errorMessage } from '@/sdk'
import { maxImages } from '../../shared/protocol.ts'
import { pictureFiles, readPicture, Thumbnails, usePictures } from './pictures.tsx'
import type { Idea, IdeaImage } from './refs.ts'

/** What the form saves; `images` only when the pictures changed, so an edit keeps their entry otherwise. */
export type Fields = { title: string; notes: string; tags: string[]; images?: IdeaImage[] }

/** "#ux, phone  later" → ["ux", "phone", "later"]; the server checks each word. */
const parseTags = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#/, '').trim())
    .filter(Boolean)

/**
 * An idea's fields: a title, and notes, pictures and tags under it. Adding, it is one line until it gets focus, text or
 * a picture, so the board stays quiet; Enter in the title saves, ⌘Enter anywhere saves, Esc cancels or clears. Pictures
 * come from the picture button (on a phone the photo library or the camera), a paste or a drop, up to four.
 */
export function IdeaForm({
  idea,
  onSave,
  onCancel,
  error,
  className,
}: {
  idea?: Idea
  onSave: (fields: Fields) => Promise<boolean>
  onCancel?: () => void
  error?: string
  className?: string
}) {
  const [title, setTitle] = useState(idea?.title ?? '')
  const [notes, setNotes] = useState(idea?.notes ?? '')
  const [tags, setTags] = useState(idea ? idea.tags.map((tag) => `#${tag}`).join(' ') : '')
  const [focused, setFocused] = useState(false)
  const [saving, setSaving] = useState(false)
  // The pictures as edited; undefined until changed, showing the idea's own meanwhile.
  const [images, setImages] = useState<IdeaImage[]>()
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState<string>()
  const stored = usePictures(idea?.images)
  const shown = images ?? stored ?? []
  const form = useRef<HTMLFormElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const open = !!idea || focused || !!title || !!notes || !!tags || shown.length > 0
  const clear = () => {
    setTitle('')
    setNotes('')
    setTags('')
    setImages(undefined)
  }
  const attach = async (files: File[]) => {
    if (!files.length || reading) return
    if (shown.length + files.length > maxImages) {
      setProblem(`At most ${maxImages} pictures`)
      return
    }
    setProblem(undefined)
    setReading(true)
    try {
      const added = await Promise.all(files.map(readPicture))
      setImages((current) => [...(current ?? stored ?? []), ...added])
    } catch (failure) {
      setProblem(errorMessage(failure))
    } finally {
      setReading(false)
    }
  }
  const save = async () => {
    if (!title.trim() || saving || reading) return
    setSaving(true)
    const saved = await onSave({
      title: title.trim(),
      notes: notes.trim(),
      tags: parseTags(tags),
      ...(images && { images }),
    })
    setSaving(false)
    if (saved && !idea) clear()
  }
  const keys = (event: KeyboardEvent, enterSaves: boolean) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && (enterSaves || event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      // oxlint-disable-next-line typescript/no-floating-promises -- onSave reports failures on the form and resolves false.
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (onCancel) onCancel()
      else {
        clear()
        ;(event.target as HTMLElement).blur()
      }
    }
  }
  const field =
    'w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground/60 disabled:opacity-60'
  return (
    <form
      className={cn(
        'min-w-0 rounded-md border border-border bg-card focus-within:border-brand/60',
        className,
      )}
      data-idea-form={idea?.id ?? 'new'}
      onBlur={(event) => {
        if (!form.current?.contains(event.relatedTarget)) setFocused(false)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        const files = pictureFiles(event.dataTransfer)
        if (!files.length) return
        event.preventDefault()
        // oxlint-disable-next-line typescript/no-floating-promises -- attach shows its own failures.
        void attach(files)
      }}
      onFocus={() => setFocused(true)}
      onPaste={(event) => {
        const files = pictureFiles(event.clipboardData)
        if (!files.length) return
        event.preventDefault()
        // oxlint-disable-next-line typescript/no-floating-promises -- attach shows its own failures.
        void attach(files)
      }}
      onSubmit={(event) => {
        event.preventDefault()
        // oxlint-disable-next-line typescript/no-floating-promises -- onSave reports failures on the form and resolves false.
        void save()
      }}
      ref={form}
    >
      <div className="flex items-center gap-1.5 px-2.5">
        {!idea && <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        <input
          aria-label="Idea title"
          autoFocus={!!idea}
          className={cn(field, 'h-9 text-[13px]', idea && 'font-medium')}
          disabled={saving}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => keys(event, true)}
          placeholder={idea ? 'Title' : 'New idea…'}
          value={title}
        />
      </div>
      {open && (
        <>
          <textarea
            aria-label="Notes"
            className={cn(
              field,
              'field-sizing-content block max-h-48 min-h-14 resize-none border-t border-border/60 px-2.5 py-2 text-[12.5px] leading-relaxed',
            )}
            disabled={saving}
            maxLength={4000}
            onChange={(event) => setNotes(event.target.value)}
            onKeyDown={(event) => keys(event, false)}
            placeholder="Notes (optional)"
            value={notes}
          />
          {shown.length > 0 && (
            <Thumbnails
              className="border-t border-border/60 px-2.5 pt-3 pb-2"
              images={shown}
              remove={
                saving
                  ? undefined
                  : (index) => setImages(shown.filter((_, other) => other !== index))
              }
              size="size-14"
            />
          )}
          <div className="flex items-center gap-2 border-t border-border/60 py-1 pr-1 pl-2.5">
            <input
              aria-label="Tags"
              className={cn(field, 'h-7 flex-1 font-mono text-[11px]')}
              disabled={saving}
              onChange={(event) => setTags(event.target.value)}
              onKeyDown={(event) => keys(event, true)}
              placeholder="#tags"
              value={tags}
            />
            <input
              accept="image/*"
              className="hidden"
              multiple
              onChange={(event) => {
                // oxlint-disable-next-line typescript/no-floating-promises -- attach shows its own failures.
                void attach(pictureFiles(event.currentTarget))
                event.currentTarget.value = ''
              }}
              ref={picker}
              type="file"
            />
            <button
              aria-label="Add a picture"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50 pointer-coarse:size-8"
              data-idea-attach
              disabled={saving || reading || shown.length >= maxImages}
              onClick={() => picker.current?.click()}
              title={`Add a picture (or paste one) · up to ${maxImages}`}
              type="button"
            >
              <ImagePlusIcon className={cn('size-3.5', reading && 'animate-pulse')} />
            </button>
            {onCancel && (
              <button
                className="h-7 shrink-0 cursor-pointer rounded-md px-2 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
            )}
            <button
              className="h-7 shrink-0 cursor-pointer rounded-md bg-brand px-2.5 font-mono text-[11px] text-brand-foreground hover:bg-brand/90 disabled:cursor-default disabled:opacity-50"
              disabled={!title.trim() || saving}
              type="submit"
            >
              {saving ? (idea ? 'Saving…' : 'Adding…') : idea ? 'Save' : 'Add idea'}
            </button>
          </div>
        </>
      )}
      {(problem ?? error) && (
        <p className="border-t border-border/60 px-2.5 py-1.5 font-mono text-[11px] break-words text-error">
          {problem ?? error}
        </p>
      )}
    </form>
  )
}
