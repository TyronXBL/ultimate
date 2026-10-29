/** An idea's pictures in the browser: loaded on demand from their entry, read from a file (shrunk to fit), shown small. */
import { XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ToolImage } from '@/components/ai/tool'
import { api, cn } from '@/sdk'
import { imageMimeTypes, maxImageBytes } from '../../shared/protocol.ts'
import type { IdeaImage } from './refs.ts'

/** Loaded pictures by entry id: an entry never changes (new pictures write a new one), so each loads once per page. */
const loaded = new Map<number, Promise<IdeaImage[]>>()

/** The pictures in `ideas.images` entry `entry` on conversation 1, fetched from its stored history. */
function load(entry: number) {
  let pictures = loaded.get(entry)
  if (!pictures) {
    pictures = api.history(1, entry + 1, undefined, entry).then((page) => {
      const data = page.entries.find((item) => item.id === entry)?.data as
        | { images?: IdeaImage[] }
        | undefined
      return data?.images ?? []
    })
    // A failed load is tried again by the next card that asks.
    pictures.catch(() => loaded.delete(entry))
    loaded.set(entry, pictures)
  }
  return pictures
}

/** The pictures of an idea whose `images` is `entry`; undefined while they load, and for an idea without any. */
export function usePictures(entry: number | undefined) {
  const [pictures, setPictures] = useState<{ entry: number; images: IdeaImage[] }>()
  useEffect(() => {
    if (entry === undefined) return undefined
    let live = true
    load(entry).then(
      (images) => {
        if (live) setPictures({ entry, images })
      },
      // Without its pictures the card still reads; only the thumbnails are missing.
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [entry])
  return entry !== undefined && pictures?.entry === entry ? pictures.images : undefined
}

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.slice(reader.result.indexOf(',') + 1))
        : reject(new Error('Could not read the picture')),
    )
    reader.addEventListener('error', () => reject(new Error('Could not read the picture')))
    reader.readAsDataURL(blob)
  })

/**
 * A picture file as an idea's picture: kept as it is when it fits (PNG, JPEG, WebP or GIF of at most 2 MiB), else
 * redrawn as a JPEG of at most 2048 px on its long side, smaller until it fits. A phone's photo is several MiB.
 */
export async function readPicture(file: Blob): Promise<IdeaImage> {
  if (imageMimeTypes.includes(file.type) && file.size <= maxImageBytes)
    return { data: await base64(file), mimeType: file.type }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture this browser can read')
  })
  try {
    for (const [side, quality] of [
      [2048, 0.85],
      [1600, 0.8],
      [1200, 0.75],
    ]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale)
      canvas.height = Math.round(bitmap.height * scale)
      const context = canvas.getContext('2d')
      if (!context) break
      // JPEG has no transparency: a transparent screenshot keeps a white page rather than a black one.
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      )
      if (blob && blob.size <= maxImageBytes)
        return { data: await base64(blob), mimeType: 'image/jpeg' }
    }
  } finally {
    bitmap.close()
  }
  throw new Error('That picture is too large to attach')
}

/** The picture files a paste, a drop or a file field carries. */
export const pictureFiles = (data: { files: FileList | null } | null) =>
  Array.from(data?.files ?? []).filter((file) => file.type.startsWith('image/'))

/**
 * Pictures as small square thumbnails, each opening large on a click; with `remove`, each has a × to take it off.
 * `size` is the thumbnail's side in Tailwind units' classes.
 */
export function Thumbnails({
  images,
  remove,
  className,
  size = 'size-10',
}: {
  images: readonly IdeaImage[]
  remove?: (index: number) => void
  className?: string
  size?: string
}) {
  if (!images.length) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} data-idea-pictures={images.length}>
      {images.map((image, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- An idea's pictures have no id and may repeat.
        <div className="relative" key={index}>
          <ToolImage
            alt={`Picture ${index + 1}`}
            className={cn(
              size,
              'rounded-md [&_img]:size-full [&_img]:max-h-none [&_img]:object-cover',
            )}
            image={image}
          />
          {remove && (
            <button
              aria-label={`Remove picture ${index + 1}`}
              className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:size-6"
              onClick={() => remove(index)}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
