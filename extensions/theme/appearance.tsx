import {
  CheckIcon,
  ChevronDownIcon,
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SunIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { api, cn, errorMessage, useDialog, useDocOf, useStore, useUltimate } from '@/sdk'
import { CODE_FONTS, UI_FONTS } from './fonts.ts'
import type { Font } from './fonts.ts'
import { DEFAULT_CHOICE, parseChoice, PRESETS, resolveTheme } from './palette.ts'
import type { Polarity } from './palette.ts'
import { SetAction, ThemeDoc } from './refs.ts'
import type { ThemeChoice } from './refs.ts'

/** The dialog ⌘K "Appearance…" and the status line's theme item open. */
export const appearanceDialog = 'theme.appearance'

// The choice being edited and not yet saved, painted on this page only: saving rewrites the user's settings and
// reloads every browser's modules, so a drag previews here and saves once, on release.
let draft: ThemeChoice | undefined
const listeners = new Set<() => void>()
const setDraft = (next: ThemeChoice | undefined) => {
  draft = next
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The unsaved choice the picker shows, if any; `ApplyTheme` paints it instead of the saved one. */
export const useDraft = () => useSyncExternalStore(subscribe, () => draft)

/** Whether two choices save to the same thing. */
const sameChoice = (a: ThemeChoice, b: ThemeChoice) =>
  JSON.stringify(parseChoice(a)) === JSON.stringify(parseChoice(b))

/** Drop the draft once the saved choice caught up with it. */
export const settleDraft = (saved: ThemeChoice) => {
  if (draft && sameChoice(draft, saved)) setDraft(undefined)
}

const ULTIMATE_HUE = 270
const DEFAULT_TINT = 0.004
const MAX_TINT = 0.04

// A CSS colour as `#rrggbb`, read back from a one-pixel canvas.
let paint: CanvasRenderingContext2D | null | undefined
function hexOf(css: string) {
  paint ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!paint) return '#000000'
  paint.fillStyle = '#000000'
  paint.fillStyle = css
  paint.fillRect(0, 0, 1, 1)
  const [r, g, b] = paint.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

// Whether a font family is installed: it renders a sample at another width than a generic fallback does.
let measure: CanvasRenderingContext2D | null | undefined
const installed = new Map<string, boolean>()
function isInstalled(family: string) {
  const known = installed.get(family)
  if (known !== undefined) return known
  measure ??= document.createElement('canvas').getContext('2d')
  if (!measure) return true
  const context = measure
  const width = (font: string) => {
    context.font = `32px ${font}`
    return context.measureText('mmmmmmmmmmlli10OWQ@').width
  }
  const found = ['monospace', 'serif', 'sans-serif'].some(
    (generic) => width(`"${family}", ${generic}`) !== width(generic),
  )
  installed.set(family, found)
  return found
}
const available = (font: Font) => font.local.length === 0 || font.local.some(isInstalled)

/** The picker: this device's light or dark, the machine's theme, a custom palette and the fonts. */
export function AppearanceDialog() {
  const [open, setOpen] = useDialog(appearanceDialog)
  return (
    // Not modal: no dimming backdrop, so the app behind repaints in full view while the user picks.
    <Dialog modal={false} onOpenChange={setOpen} open={open}>
      <DialogContent
        className={cn(
          'top-auto right-0 bottom-0 left-0 flex max-h-[80dvh] max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-b-none p-0 font-mono',
          'sm:top-12 sm:right-3 sm:bottom-auto sm:left-auto sm:max-h-[calc(100dvh-5rem)] sm:w-[25rem] sm:max-w-[25rem] sm:rounded-lg',
        )}
        data-appearance
        onOpenAutoFocus={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        {open && <Body onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function Body({ onClose }: { onClose: () => void }) {
  const saved = useDocOf(1, ThemeDoc)?.choice ?? DEFAULT_CHOICE
  const choice = useDraft() ?? saved
  const polarity = useStore((state) => state.ui.theme)
  const [error, setError] = useState<string>()

  const save = (next: ThemeChoice) => {
    setDraft(next)
    setError(undefined)
    api.action(SetAction, next).then(
      (stored) => {
        // A newer edit owns the draft now.
        if (draft === next) setDraft(stored)
      },
      (failure: unknown) => {
        if (draft === next) setDraft(undefined)
        setError(errorMessage(failure))
      },
    )
  }
  const custom = (patch: Partial<ThemeChoice>): ThemeChoice => ({
    ...choice,
    ...patch,
    preset: 'custom',
  })

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-3">
        <DialogTitle className="text-[12px] font-normal text-foreground">Appearance</DialogTitle>
        <DialogDescription className="sr-only">
          Light or dark for this device; theme and fonts for all of your devices.
        </DialogDescription>
        <button
          aria-label="Close"
          className="ml-auto grid size-7 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        <Section hint="this device" title="Mode">
          <ModePicker />
        </Section>
        <Section hint="all devices" title="Theme">
          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((preset) => (
              <Tile
                current={choice.preset === preset.id}
                key={preset.id}
                label={preset.label}
                onSelect={() => save({ ...choice, preset: preset.id })}
                swatches={preset.swatches[polarity]}
              />
            ))}
            <Tile
              current={choice.preset === 'custom'}
              label="Custom"
              onSelect={() => save(custom({}))}
              swatches={customSwatches(choice, polarity)}
            />
          </div>
          {choice.preset === 'custom' && (
            <CustomControls choice={choice} custom={custom} onDraft={setDraft} onSave={save} />
          )}
        </Section>
        <Section title="Fonts">
          <div className="grid gap-1.5">
            <FontPicker
              current={choice.uiFont}
              fonts={UI_FONTS}
              label="Interface"
              onSelect={(uiFont) => save({ ...choice, uiFont })}
            />
            <FontPicker
              current={choice.codeFont}
              fonts={CODE_FONTS}
              label="Code"
              onSelect={(codeFont) => save({ ...choice, codeFont })}
            />
          </div>
        </Section>
      </div>
      <div className="shrink-0 border-t border-border/70 px-3 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] text-[11px] text-muted-foreground">
        {error ? (
          <span className="text-error">{error}</span>
        ) : (
          'Theme and fonts sync to all your devices'
        )}
      </div>
    </>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="px-3 pt-3">
      <h3 className="mb-2 flex items-baseline justify-between text-[10.5px] tracking-wider text-muted-foreground uppercase">
        {title}
        {hint && (
          <span className="tracking-normal normal-case text-muted-foreground/70">{hint}</span>
        )}
      </h3>
      {children}
    </section>
  )
}

const MODES = [
  { mode: 'system', label: 'System', Icon: MonitorIcon },
  { mode: 'light', label: 'Light', Icon: SunIcon },
  { mode: 'dark', label: 'Dark', Icon: MoonIcon },
] as const

/** This device's light or dark: a segmented control, applied at once and kept in this browser only. */
function ModePicker() {
  const current = useStore((state) => state.ui.themeMode)
  const { setTheme } = useUltimate()
  return (
    <div className="grid grid-cols-3 gap-0.5 rounded-md bg-muted p-0.5" role="radiogroup">
      {MODES.map(({ mode, label, Icon }) => (
        <button
          aria-checked={current === mode}
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-[5px] text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-7',
            current === mode && 'bg-background text-foreground shadow-sm',
          )}
          key={mode}
          onClick={() => setTheme(mode)}
          role="radio"
          type="button"
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}

const customSwatches = (choice: ThemeChoice, polarity: Polarity) => {
  const { vars } = resolveTheme({ ...choice, preset: 'custom' }, polarity)
  return [vars.background, vars.card, vars.foreground, vars.brand] as const
}

/** A preset as a tiny window in its own colours: a sidebar in the card colour, two lines of text and the accent. */
function Tile({
  label,
  swatches: [background, card, foreground, brand],
  current,
  onSelect,
}: {
  label: string
  swatches: readonly [string, string, string, string]
  current: boolean
  onSelect: () => void
}) {
  return (
    <button
      aria-pressed={current}
      className="group flex min-w-0 flex-col gap-1 rounded-md text-left outline-none"
      onClick={onSelect}
      type="button"
    >
      <span
        className={cn(
          'flex h-12 w-full overflow-hidden rounded-md border border-border transition-shadow group-hover:border-muted-foreground/50 group-focus-visible:ring-2 group-focus-visible:ring-ring',
          current && 'border-transparent ring-2 ring-brand group-hover:border-transparent',
        )}
        style={{ background }}
      >
        <span className="w-1/4 shrink-0" style={{ background: card }} />
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2">
          <span className="h-1 w-4/5 rounded-full opacity-90" style={{ background: foreground }} />
          <span className="h-1 w-1/2 rounded-full opacity-50" style={{ background: foreground }} />
          <span className="mt-0.5 h-1.5 w-5 rounded-full" style={{ background: brand }} />
        </span>
      </span>
      <span
        className={cn(
          'flex items-center gap-1 truncate px-0.5 text-[11.5px] text-muted-foreground group-hover:text-foreground',
          current && 'text-foreground',
        )}
      >
        {label}
        {current && <CheckIcon className="size-3 shrink-0 text-brand" />}
      </span>
    </button>
  )
}

const hueTrack = `linear-gradient(to right, ${Array.from(
  { length: 13 },
  (_, step) => `oklch(0.72 0.13 ${step * 30})`,
).join(', ')})`

/** Accent, base hue and tint, high contrast; each saves once the user lets go, and previews while they drag. */
function CustomControls({
  choice,
  custom,
  onDraft,
  onSave,
}: {
  choice: ThemeChoice
  custom: (patch: Partial<ThemeChoice>) => ThemeChoice
  onDraft: (next: ThemeChoice) => void
  onSave: (next: ThemeChoice) => void
}) {
  const polarity = useStore((state) => state.ui.theme)
  const hue = choice.hue ?? ULTIMATE_HUE
  const tint = choice.tint ?? DEFAULT_TINT
  const accent = choice.accent ?? hexOf(resolveTheme({ preset: 'ultimate' }, polarity).vars.brand)
  return (
    <div className="mt-3 grid gap-2.5 rounded-md border border-border/70 bg-card/60 p-2.5">
      <Field label="Accent">
        <ColorInput
          onCommit={(value) => onSave(custom({ accent: value }))}
          onDraft={(value) => onDraft(custom({ accent: value }))}
          value={accent}
        />
      </Field>
      <Field label="Base hue" value={`${Math.round(hue)}°`}>
        <Slider
          label="Base hue"
          max={360}
          min={0}
          onCommit={(value) => onSave(custom({ hue: value }))}
          onDraft={(value) => onDraft(custom({ hue: value }))}
          step={1}
          track={hueTrack}
          value={hue}
        />
      </Field>
      <Field label="Tint" value={`${Math.round((tint / MAX_TINT) * 100)}%`}>
        <Slider
          label="Tint"
          max={MAX_TINT}
          min={0}
          onCommit={(value) => onSave(custom({ tint: value }))}
          onDraft={(value) => onDraft(custom({ tint: value }))}
          step={0.001}
          track={`linear-gradient(to right, oklch(0.62 0 ${hue}), oklch(0.62 0.13 ${hue}))`}
          value={tint}
        />
      </Field>
      <label className="flex h-7 cursor-pointer items-center justify-between text-[12px] text-foreground/85">
        High contrast
        <Switch
          checked={choice.contrast === 'high'}
          onCheckedChange={(on) => onSave(custom({ contrast: on ? 'high' : 'normal' }))}
        />
      </label>
      <Readability choice={choice} />
    </div>
  )
}

function Field({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-[12px] text-foreground/85">
        {label}
        {value && <span className="text-[11px] text-muted-foreground tabular-nums">{value}</span>}
      </div>
      {children}
    </div>
  )
}

/** A range on a coloured track; the native `change` event, fired on release, saves. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  track,
  onDraft,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  track: string
  onDraft: (value: number) => void
  onCommit: (value: number) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const commit = useEffectEvent(() => onCommit(Number(ref.current?.value)))
  useEffect(() => {
    const input = ref.current
    input?.addEventListener('change', commit)
    return () => input?.removeEventListener('change', commit)
  }, [])
  return (
    <input
      aria-label={label}
      className={cn(
        'h-6 w-full cursor-pointer appearance-none bg-transparent outline-none',
        '[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:[background:var(--track)]',
        '[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:[background:var(--track)]',
        '[&::-webkit-slider-thumb]:-mt-[6px] [&::-webkit-slider-thumb]:size-[18px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--color-border)]',
        '[&::-moz-range-thumb]:size-[18px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--color-border)]',
        'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring',
      )}
      max={max}
      min={min}
      onChange={(event) => onDraft(Number(event.target.value))}
      ref={ref}
      step={step}
      style={{ '--track': track } as CSSProperties}
      type="range"
      value={value}
    />
  )
}

/** A colour well and its hex: the well previews while its picker is open and saves when it closes. */
function ColorInput({
  value,
  onDraft,
  onCommit,
}: {
  value: string
  onDraft: (value: string) => void
  onCommit: (value: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = useEffectEvent(() => {
    if (ref.current) onCommit(ref.current.value)
  })
  useEffect(() => {
    const input = ref.current
    input?.addEventListener('change', commit)
    return () => input?.removeEventListener('change', commit)
  }, [])
  const typed = () => {
    const hex = text.trim().toLowerCase().replace(/^#?/, '#')
    if (/^#[0-9a-f]{6}$/.test(hex)) {
      if (hex !== value) onCommit(hex)
    } else setText(value)
  }
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Accent colour"
        className="h-7 w-10 shrink-0 cursor-pointer rounded-sm border border-input bg-transparent p-0.5 [&::-moz-color-swatch]:rounded-[3px] [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
        onChange={(event) => onDraft(event.target.value)}
        ref={ref}
        type="color"
        value={value}
      />
      <input
        aria-label="Accent hex"
        className="h-7 w-24 min-w-0 rounded-sm border border-input bg-transparent px-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        onBlur={typed}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && typed()}
        spellCheck={false}
        value={text}
      />
    </div>
  )
}

const NAMES: Record<string, string> = {
  foreground: 'Text',
  'muted-foreground': 'Muted text',
  brand: 'Accent',
  'brand-foreground': 'Text on the accent',
  success: 'Success colour',
  warning: 'Warning colour',
  error: 'Error colour',
}

/**
 * Which of the user's colours the engine moved to keep text readable, in either light or dark, so a colour that
 * looks different from the one picked is explained rather than a surprise.
 */
function Readability({ choice }: { choice: ThemeChoice }) {
  const { accent } = choice
  const changes = (['light', 'dark'] as const).flatMap((polarity) => {
    const { vars, checks } = resolveTheme(choice, polarity)
    const seen = new Set<string>()
    return checks.flatMap((check) => {
      const token = check.pair.split('/')[0]
      if (!check.adjusted || seen.has(token)) return []
      seen.add(token)
      const failing = checks.filter((other) => other.pair.startsWith(`${token}/`))
      const ratio = Math.min(...failing.map((other) => other.ratio))
      return [{ polarity, token, ratio, min: check.min, shown: vars[token] }]
    })
  })
  if (changes.length === 0) return null
  return (
    <div className="grid gap-1.5 border-t border-border/70 pt-2.5 text-[11.5px] text-muted-foreground">
      <div className="flex items-center gap-1.5 text-foreground/85">
        <InfoIcon className="size-3.5 shrink-0 text-muted-foreground" />
        Adjusted for readability
      </div>
      {changes.map(({ polarity, token, ratio, min, shown }) => (
        <div className="flex items-center gap-2 pl-5" key={`${polarity}-${token}`}>
          {token === 'brand' && accent && (
            <span aria-hidden className="flex shrink-0 items-center gap-0.5">
              <span
                className="size-3 rounded-[3px] border border-border"
                style={{ background: accent }}
              />
              <span className="text-[10px]">→</span>
              <span
                className="size-3 rounded-[3px] border border-border"
                style={{ background: shown }}
              />
            </span>
          )}
          <span className="min-w-0 flex-1">
            {NAMES[token] ?? token}{' '}
            {token === 'brand-foreground'
              ? 'adjusted'
              : polarity === 'light'
                ? 'darker'
                : 'lighter'}{' '}
            in {polarity}
          </span>
          <span
            className="shrink-0 tabular-nums"
            title={`WCAG contrast; at least ${min}:1 is needed`}
          >
            {ratio.toFixed(1)}:1
          </span>
        </div>
      ))}
      <p className="pl-5 text-[11px] leading-snug text-muted-foreground/80">
        Colours too close to their background are moved until text reaches WCAG contrast.
      </p>
    </div>
  )
}

/** One font role: the current font in its own face, and a menu of the rest; fonts this device lacks are disabled. */
function FontPicker({
  label,
  fonts,
  current,
  onSelect,
}: {
  label: string
  fonts: readonly Font[]
  current: string | undefined
  onSelect: (id: string) => void
}) {
  const selected = fonts.find((font) => font.id === current) ?? fonts[0]
  return (
    <div className="flex items-center gap-2">
      <span className="w-[4.5rem] shrink-0 text-[12px] text-foreground/85">{label}</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm border border-input px-2 text-left text-[12.5px] text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent sm:h-7"
            type="button"
          >
            <span className="min-w-0 flex-1 truncate" style={{ fontFamily: selected.css }}>
              {selected.label}
            </span>
            {!available(selected) && (
              <span className="shrink-0 text-[10.5px] text-muted-foreground">not installed</span>
            )}
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuRadioGroup onValueChange={onSelect} value={selected.id}>
            {fonts.map((font) => {
              const usable = available(font)
              return (
                <DropdownMenuRadioItem
                  className="h-8 text-[13px] sm:h-7"
                  disabled={!usable}
                  key={font.id}
                  value={font.id}
                >
                  <span className="min-w-0 flex-1 truncate" style={{ fontFamily: font.css }}>
                    {font.label}
                  </span>
                  {!usable && (
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      not installed
                    </span>
                  )}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** The status line's way in, beside sounds; on a phone it sits in the line's ⋯ menu. */
export function AppearanceButton() {
  const { open } = useUltimate()
  return (
    <button
      aria-label="Appearance"
      className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
      onClick={() => open(appearanceDialog)}
      type="button"
    >
      <PaletteIcon className="size-3" />
      theme
    </button>
  )
}
