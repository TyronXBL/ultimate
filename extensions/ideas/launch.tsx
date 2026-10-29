import type { EntryRecord } from '@earendil-works/pi-durable'
import { LightbulbIcon } from 'lucide-react'
import { Fold, useUltimate } from '@/sdk'
import { imagesOf } from '../../lib/entries.ts'
import { Thumbnails } from './pictures.tsx'
import type { LaunchEntry } from './refs.ts'

const sizes = { assess: 'assess first', build: 'build' }

/**
 * An idea the user launched from the board, in @ultimate's transcript: on the user's side, like their typed messages,
 * naming the idea, how it starts and the pictures that went with it. The header opens the Board.
 */
export function LaunchCard({ entry }: { entry: EntryRecord }) {
  const { id, title, size } = entry.data as LaunchEntry
  const { showSurface } = useUltimate()
  // The pictures went along in the input itself, for @ultimate to pass on to the branch.
  const images = imagesOf(entry)
  const head = (
    <>
      <LightbulbIcon className="size-3 shrink-0 text-brand" />
      <span className="min-w-0 truncate">
        Idea launched · <span className="text-foreground/85">{sizes[size]}</span>
        {images.length > 0 && ` · ${images.length} ${images.length === 1 ? 'picture' : 'pictures'}`}
      </span>
    </>
  )
  return (
    <div className="mt-3 flex justify-end first:mt-0">
      <Fold card={entry.id} keep summary={head}>
        <section
          className="w-full max-w-md min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40"
          data-idea-launch-card={id}
        >
          <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            {head}
            <button
              className="ml-auto shrink-0 cursor-pointer hover:text-foreground hover:underline"
              onClick={() => showSurface('ideas')}
              title="Open the Board"
              type="button"
            >
              idea {id}
            </button>
          </header>
          <p className="px-3 py-2 text-[13.5px] leading-snug break-words">{title}</p>
          <Thumbnails className="px-3 pb-2.5" images={images} size="size-14" />
        </section>
      </Fold>
    </div>
  )
}
