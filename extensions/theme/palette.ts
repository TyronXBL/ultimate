/**
 * Theme palettes, browser-safe and pure: a machine's theme choice resolves, per light or dark, to the CSS tokens of
 * `web/src/index.css`, the browser-bar colour and the contrast checks that shaped them.
 */

export type Polarity = 'dark' | 'light'

/** The machine's theme choice, stored as `theme` in `~/.ultimate/settings.json`. */
export type ThemeChoice = {
  /** A preset id (`PRESETS`), or `custom`. */
  preset: string
  /** `custom` only: the accent, `#rrggbb`. */
  accent?: string
  /** `custom` only: the base hue in degrees, 0–360. */
  hue?: number
  /** `custom` only: how strongly the base takes the hue, an oklch chroma from 0 to 0.04. */
  tint?: number
  /** `custom` only: high contrast. */
  contrast?: 'normal' | 'high'
  /** A `UI_FONTS` id. */
  uiFont?: string
  /** A `CODE_FONTS` id. */
  codeFont?: string
}

export type Preset = {
  id: string
  label: string
  /** Swatches for a picker: background, surface, foreground and accent in each polarity, as CSS colours. */
  swatches: Record<Polarity, [string, string, string, string]>
}

/** One readability check: a text colour against its background, the WCAG 2 ratio reached and the one required. */
export type Check = {
  pair: string
  ratio: number
  min: number
  /** The generator moved the text colour's lightness to reach `min`. */
  adjusted: boolean
}

export type Resolved = {
  /** Token name (no leading `--`) → CSS colour, every base token of `web/src/index.css`. */
  vars: Record<string, string>
  /** The background as `#rrggbb`, for `<meta name="theme-color">`. */
  themeColor: string
  checks: Check[]
}

export const DEFAULT_CHOICE: ThemeChoice = { preset: 'ultimate' }

/** The current Ultimate tokens, as `web/src/index.css` defines them. Contract stub: E1.1 replaces this file's body. */
const ULTIMATE: Record<Polarity, Record<string, string>> = {
  light: {
    background: 'oklch(0.985 0.002 270)',
    foreground: 'oklch(0.22 0.006 270)',
    card: 'oklch(0.97 0.003 270)',
    popover: 'oklch(0.995 0.001 270)',
    primary: 'oklch(0.24 0.006 270)',
    'primary-foreground': 'oklch(0.98 0.002 270)',
    secondary: 'oklch(0.94 0.004 270)',
    muted: 'oklch(0.945 0.004 270)',
    'muted-foreground': 'oklch(0.5 0.012 270)',
    accent: 'oklch(0.93 0.005 270)',
    destructive: 'oklch(0.56 0.19 25)',
    border: 'oklch(0.9 0.005 270)',
    input: 'oklch(0.86 0.006 270)',
    ring: 'oklch(0.55 0.17 300 / 0.55)',
    brand: 'oklch(0.52 0.18 300)',
    'brand-foreground': 'oklch(0.98 0.01 300)',
    success: 'oklch(0.55 0.14 155)',
    warning: 'oklch(0.6 0.14 70)',
    note: 'oklch(0.74 0.11 92)',
    error: 'oklch(0.56 0.19 25)',
    'diff-add': 'oklch(0.5 0.14 160)',
    'diff-del': 'oklch(0.53 0.18 25)',
    terminal: 'oklch(0.955 0.003 270)',
    sidebar: 'oklch(0.965 0.003 270)',
  },
  dark: {
    background: 'oklch(0.178 0.003 270)',
    foreground: 'oklch(0.87 0.004 270)',
    card: 'oklch(0.2 0.004 270)',
    popover: 'oklch(0.205 0.004 270)',
    primary: 'oklch(0.9 0.004 270)',
    'primary-foreground': 'oklch(0.2 0.004 270)',
    secondary: 'oklch(0.235 0.005 270)',
    muted: 'oklch(0.235 0.005 270)',
    'muted-foreground': 'oklch(0.64 0.01 270)',
    accent: 'oklch(0.255 0.006 270)',
    destructive: 'oklch(0.66 0.18 25)',
    border: 'oklch(0.275 0.005 270)',
    input: 'oklch(0.3 0.006 270)',
    ring: 'oklch(0.74 0.13 300 / 0.5)',
    brand: 'oklch(0.75 0.13 300)',
    'brand-foreground': 'oklch(0.2 0.03 300)',
    success: 'oklch(0.76 0.14 155)',
    warning: 'oklch(0.82 0.13 80)',
    note: 'oklch(0.85 0.09 95)',
    error: 'oklch(0.7 0.17 25)',
    'diff-add': 'oklch(0.78 0.14 160)',
    'diff-del': 'oklch(0.72 0.16 25)',
    terminal: 'oklch(0.155 0.003 270)',
    sidebar: 'oklch(0.165 0.003 270)',
  },
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'ultimate',
    label: 'Ultimate',
    swatches: {
      dark: [
        'oklch(0.178 0.003 270)',
        'oklch(0.2 0.004 270)',
        'oklch(0.87 0.004 270)',
        'oklch(0.75 0.13 300)',
      ],
      light: [
        'oklch(0.985 0.002 270)',
        'oklch(0.97 0.003 270)',
        'oklch(0.22 0.006 270)',
        'oklch(0.52 0.18 300)',
      ],
    },
  },
]

/** `choice` in `polarity`: every base token, the browser-bar colour and the readability checks. */
export function resolveTheme(_choice: ThemeChoice, polarity: Polarity): Resolved {
  return {
    vars: { ...ULTIMATE[polarity] },
    themeColor: polarity === 'dark' ? '#111112' : '#f9fafb',
    checks: [],
  }
}

/** A stored or submitted value as a choice; undefined when it is not one (unknown preset, bad colour, out of range). */
export function parseChoice(value: unknown): ThemeChoice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { preset } = value as { preset?: unknown }
  return preset === 'ultimate' ? { preset } : undefined
}
