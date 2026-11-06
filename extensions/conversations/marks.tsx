import { BotIcon, BrainIcon, GitMergeIcon, ScrollTextIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { cn, useDocOf } from '@/sdk'
import type { MarkTint } from '../../lib/marks.ts'
import { MarksDoc } from './refs.ts'
import type { AgentMarkStyle } from './refs.ts'

/** The display names of the agents Ultimate ships with; any other standing agent is its name, capitalised. */
const names: Record<string, string> = {
  ultimate: 'Ultimate',
  lander: 'Lander',
}
const agentTitle = (name: string) => names[name] ?? name.charAt(0).toUpperCase() + name.slice(1)

/**
 * What the UI calls an agent: a standing agent's definition `title` (the marks doc), else its built-in or capitalised
 * name. `brand` is @ultimate without a title of its own, which shows as the ULTIMATE wordmark. Empty until the marks
 * doc arrives, so a page load never flashes the default name before the title.
 */
export function useAgentTitle(name: string) {
  const marks = useDocOf(1, MarksDoc)
  if (marks === undefined) return { title: '', brand: false }
  const title = marks?.[name]?.title
  return { title: title ?? agentTitle(name), brand: name === 'ultimate' && !title }
}

/** A standing agent's display name, as `useAgentTitle` gives it. */
export const AgentTitle = ({ name }: { name: string }) => useAgentTitle(name).title

const initialGlyph = (text: string) => (
  <span className="font-sans leading-none font-semibold">{text}</span>
)

/**
 * Each built-in tile: its tint and glyph. Glyphs size to the tile through `size-[60%]`. Every other standing agent
 * takes its definition's `icon` and `tint` (the marks doc), else the grey bot.
 */
const tiles: Record<string, { tint: string; glyph: ReactNode }> = {
  ultimate: {
    tint: 'bg-brand/12 text-brand ring-brand/25',
    // The top bar's wordmark, reduced to its first letter; a definition title's first letter replaces it.
    glyph: initialGlyph('U'),
  },
  lander: {
    tint: 'bg-success/10 text-success ring-success/25',
    glyph: <GitMergeIcon className="size-[60%]" strokeWidth={2.25} />,
  },
  root: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <ScrollTextIcon className="size-[58%]" strokeWidth={2} />,
  },
  memory: {
    tint: 'bg-brand/8 text-brand/90 ring-brand/20',
    glyph: <BrainIcon className="size-[58%]" strokeWidth={2} />,
  },
}
const fallbackTint = 'bg-muted text-muted-foreground ring-border'
const fallbackGlyph = <BotIcon className="size-[60%]" strokeWidth={2} />

/** The classes of each tint a definition may name; spelled out so Tailwind generates them. */
const tints: Record<MarkTint, string> = {
  violet: 'bg-violet-500/12 text-violet-600 ring-violet-500/25 dark:text-violet-300',
  blue: 'bg-blue-500/12 text-blue-600 ring-blue-500/25 dark:text-blue-300',
  green: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300',
  amber: 'bg-amber-500/14 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  red: 'bg-red-500/12 text-red-600 ring-red-500/25 dark:text-red-300',
  pink: 'bg-pink-500/12 text-pink-600 ring-pink-500/25 dark:text-pink-300',
  teal: 'bg-teal-500/12 text-teal-700 ring-teal-500/25 dark:text-teal-300',
  grey: fallbackTint,
}

type Icons = (typeof import('./lucide-icons.tsx'))['icons']
// The whole icon set was a fifth of the startup JavaScript while no definition named an icon (#166097): it loads on
// the first mark that needs it.
let loadedIcons: Icons | undefined
let loadingIcons: Promise<Icons> | undefined

/** lucide's icon map once loaded, `null` when loading it failed; `wanted` starts loading it. */
function useIcons(wanted: boolean) {
  const [icons, setIcons] = useState<Icons | null | undefined>(loadedIcons)
  const current = icons === undefined ? loadedIcons : icons
  useEffect(() => {
    if (!wanted || current !== undefined) return
    loadingIcons ??= import('./lucide-icons.tsx').then((module) => (loadedIcons = module.icons))
    loadingIcons.then(setIcons, (error: unknown) => {
      // A later mark tries again; this one shows the default.
      loadingIcons = undefined
      console.warn('Could not load the lucide icons; agent marks show the default', error)
      setIcons(null)
    })
  }, [wanted, current])
  return current
}

/** A lucide icon by the name a definition gives, PascalCase or kebab-case; undefined for an unknown one. */
const iconOf = (icons: Icons, name: string) =>
  icons[
    name.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, letter: string) =>
      letter.toUpperCase(),
    ) as keyof Icons
  ]

const warned = new Set<string>()
/**
 * A standing agent's tile as its definition's `icon` and `tint` ask, else the grey bot; no glyph while the icons load,
 * so a configured icon never flashes the bot first.
 */
function definedTile(style: AgentMarkStyle | undefined, icons: Icons | null | undefined) {
  const tint = (style?.tint && tints[style.tint as MarkTint]) || fallbackTint
  if (!style?.icon || icons === null) return { tint, glyph: fallbackGlyph }
  if (!icons) return { tint, glyph: null }
  const Icon = iconOf(icons, style.icon)
  if (!Icon && !warned.has(style.icon)) {
    warned.add(style.icon)
    console.warn(`Unknown lucide icon "${style.icon}" in an agent definition; showing the default`)
  }
  return { tint, glyph: Icon ? <Icon className="size-[60%]" strokeWidth={2} /> : fallbackGlyph }
}

/** The presence dot in a mark's corner: pulsing while it works, amber while it waits on you, else muted. */
export type Presence = 'working' | 'waiting' | 'idle'

/**
 * An agent's avatar: a small rounded tile in its colour with its glyph, the same in the sidebar, the title bar and
 * chat headers. `name` is a standing agent's name, `lander`, `root` for a project's context or `memory` for its memory.
 */
export function AgentMark({
  name,
  size = 'md',
  presence,
}: {
  name: string
  size?: 'xs' | 'sm' | 'md'
  presence?: Presence
}) {
  const marks = useDocOf(1, MarksDoc)
  const style = marks?.[name]
  const icons = useIcons(!tiles[name] && !!style?.icon)
  const tile = tiles[name] ?? definedTile(style, icons)
  // @ultimate's letter is its title's first; unknown, and so blank, until the marks doc arrives.
  const glyph =
    name !== 'ultimate'
      ? tile.glyph
      : marks === undefined
        ? null
        : style?.title
          ? initialGlyph(Array.from(style.title)[0])
          : tile.glyph
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset',
        tile.tint,
        size === 'md' && 'size-6 text-[12px]',
        size === 'sm' && 'size-4 rounded-[4px] text-[9.5px]',
        size === 'xs' && 'size-3.5 rounded-[3px] text-[8.5px]',
      )}
      data-agent-mark={name}
    >
      {glyph}
      {presence && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar',
            size === 'md' ? 'size-2' : 'size-1.5 ring-[1.5px]',
            presence === 'working'
              ? 'animate-pulse-dot bg-brand'
              : presence === 'waiting'
                ? 'bg-amber-400'
                : 'bg-muted-foreground/60',
          )}
          data-presence={presence}
        />
      )}
    </span>
  )
}
