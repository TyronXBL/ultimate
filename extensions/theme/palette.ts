/**
 * Theme palettes, browser-safe and pure: a machine's theme choice resolves, per light or dark, to the CSS tokens of
 * `web/src/index.css`, the browser-bar colour and the contrast checks that shaped them.
 *
 * Generated palettes take a base hue and tint, a lightness ladder and an accent; hand-tuned ones are fixed tables.
 * Either way, every text colour is checked against its background (WCAG 2) and moved in OKLCH lightness until it
 * passes, except Ultimate's own tokens, which are the reference and stay exactly as `index.css` has them.
 */

import { CODE_FONTS, UI_FONTS } from './fonts.ts'
import type { ThemeChoice } from './refs.ts'

export type Polarity = 'dark' | 'light'

export type Preset = {
  id: string
  label: string
  /** Swatches for a picker: background, card, foreground and brand in each polarity, as CSS colours. */
  swatches: Record<Polarity, [string, string, string, string]>
}

/** One readability check: a text colour against its background, the WCAG 2 ratio reached and the one required. */
type Check = {
  pair: string
  ratio: number
  min: number
  /** The text colour's lightness was moved to reach `min`. */
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

type Tokens = Record<string, string>

/** Today's tokens, exactly as `web/src/index.css` defines them. */
const ULTIMATE: Record<Polarity, Tokens> = {
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

/** Neutral tokens by OKLCH lightness; their hue and chroma come from the base. */
type Ladder = Record<
  | 'background'
  | 'foreground'
  | 'card'
  | 'popover'
  | 'primary'
  | 'primary-foreground'
  | 'secondary'
  | 'muted'
  | 'muted-foreground'
  | 'accent'
  | 'border'
  | 'input'
  | 'terminal'
  | 'sidebar',
  number
>

const LADDERS: Record<'normal' | 'high', Record<Polarity, Ladder>> = {
  normal: {
    dark: {
      background: 0.178,
      foreground: 0.87,
      card: 0.2,
      popover: 0.205,
      primary: 0.9,
      'primary-foreground': 0.2,
      secondary: 0.235,
      muted: 0.235,
      'muted-foreground': 0.66,
      accent: 0.255,
      border: 0.275,
      input: 0.3,
      terminal: 0.155,
      sidebar: 0.165,
    },
    light: {
      background: 0.985,
      foreground: 0.22,
      card: 0.97,
      popover: 0.995,
      primary: 0.24,
      'primary-foreground': 0.98,
      secondary: 0.94,
      muted: 0.945,
      'muted-foreground': 0.5,
      accent: 0.93,
      border: 0.9,
      input: 0.86,
      terminal: 0.955,
      sidebar: 0.965,
    },
  },
  high: {
    dark: {
      background: 0.1,
      foreground: 0.98,
      card: 0.14,
      popover: 0.16,
      primary: 0.99,
      'primary-foreground': 0.1,
      secondary: 0.2,
      muted: 0.2,
      'muted-foreground': 0.86,
      accent: 0.24,
      border: 0.5,
      input: 0.58,
      terminal: 0.06,
      sidebar: 0.08,
    },
    light: {
      background: 1,
      foreground: 0.12,
      card: 0.98,
      popover: 1,
      primary: 0.1,
      'primary-foreground': 1,
      secondary: 0.94,
      muted: 0.94,
      'muted-foreground': 0.3,
      accent: 0.9,
      border: 0.45,
      input: 0.4,
      terminal: 0.96,
      sidebar: 0.97,
    },
  },
}

/** State colours of high-contrast palettes; normal ones keep Ultimate's. */
const HIGH_STATES: Record<Polarity, Tokens> = {
  dark: {
    destructive: 'oklch(0.74 0.18 25)',
    success: 'oklch(0.84 0.16 155)',
    warning: 'oklch(0.9 0.15 85)',
    note: 'oklch(0.92 0.1 95)',
    error: 'oklch(0.76 0.17 25)',
    'diff-add': 'oklch(0.86 0.15 160)',
    'diff-del': 'oklch(0.78 0.16 25)',
  },
  light: {
    destructive: 'oklch(0.46 0.2 25)',
    success: 'oklch(0.42 0.14 155)',
    warning: 'oklch(0.48 0.13 70)',
    note: 'oklch(0.55 0.12 92)',
    error: 'oklch(0.46 0.2 25)',
    'diff-add': 'oklch(0.4 0.14 160)',
    'diff-del': 'oklch(0.44 0.19 25)',
  },
}

const STATES = [
  'destructive',
  'success',
  'warning',
  'note',
  'error',
  'diff-add',
  'diff-del',
] as const

type Lch = [l: number, c: number, h: number]

/** A generated palette: base hue and tint (light polarity tints at 60%), an accent per polarity. */
type Generated = {
  hue: number
  tint: number
  contrast: 'normal' | 'high'
  accent: Record<Polarity, Lch | string>
}

const GENERATED: Record<string, Generated & { label: string }> = {
  midnight: {
    label: 'Midnight',
    hue: 250,
    tint: 0.025,
    contrast: 'normal',
    accent: { dark: [0.78, 0.13, 220], light: [0.5, 0.12, 235] },
  },
  ember: {
    label: 'Ember',
    hue: 55,
    tint: 0.014,
    contrast: 'normal',
    accent: { dark: [0.78, 0.15, 55], light: [0.52, 0.15, 45] },
  },
  sage: {
    label: 'Sage',
    hue: 150,
    tint: 0.012,
    contrast: 'normal',
    accent: { dark: [0.76, 0.1, 180], light: [0.5, 0.11, 185] },
  },
  'high-contrast': {
    label: 'High contrast',
    hue: 0,
    tint: 0,
    contrast: 'high',
    accent: { dark: [0.9, 0.17, 100], light: [0.42, 0.2, 265] },
  },
}

/** Hand-tuned palettes, from each theme's published colours. */
const TUNED: Record<string, { label: string } & Record<Polarity, Tokens>> = {
  catppuccin: {
    label: 'Catppuccin',
    // Mocha
    dark: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      card: '#262637',
      popover: '#313244',
      primary: '#cdd6f4',
      'primary-foreground': '#1e1e2e',
      secondary: '#313244',
      muted: '#313244',
      'muted-foreground': '#a6adc8',
      accent: '#45475a',
      destructive: '#f38ba8',
      border: '#45475a',
      input: '#585b70',
      ring: '#cba6f780',
      brand: '#cba6f7',
      'brand-foreground': '#11111b',
      success: '#a6e3a1',
      warning: '#f9e2af',
      note: '#f9e2af',
      error: '#f38ba8',
      'diff-add': '#a6e3a1',
      'diff-del': '#f38ba8',
      terminal: '#11111b',
      sidebar: '#181825',
    },
    // Latte
    light: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      card: '#f8f9fb',
      popover: '#f8f9fb',
      primary: '#4c4f69',
      'primary-foreground': '#eff1f5',
      secondary: '#dce0e8',
      muted: '#dce0e8',
      'muted-foreground': '#6c6f85',
      accent: '#ccd0da',
      destructive: '#d20f39',
      border: '#ccd0da',
      input: '#acb0be',
      ring: '#8839ef66',
      brand: '#8839ef',
      'brand-foreground': '#ffffff',
      success: '#40a02b',
      warning: '#df8e1d',
      note: '#df8e1d',
      error: '#d20f39',
      'diff-add': '#40a02b',
      'diff-del': '#d20f39',
      terminal: '#dce0e8',
      sidebar: '#e6e9ef',
    },
  },
  nord: {
    label: 'Nord',
    // Polar Night
    dark: {
      background: '#2e3440',
      foreground: '#e5e9f0',
      card: '#343b49',
      popover: '#3b4252',
      primary: '#e5e9f0',
      'primary-foreground': '#2e3440',
      secondary: '#3b4252',
      muted: '#3b4252',
      'muted-foreground': '#d8dee9',
      accent: '#434c5e',
      destructive: '#bf616a',
      border: '#434c5e',
      input: '#4c566a',
      ring: '#88c0d080',
      brand: '#88c0d0',
      'brand-foreground': '#2e3440',
      success: '#a3be8c',
      warning: '#ebcb8b',
      note: '#ebcb8b',
      error: '#bf616a',
      'diff-add': '#a3be8c',
      'diff-del': '#bf616a',
      terminal: '#242933',
      sidebar: '#272c36',
    },
    // Snow Storm, with Polar Night ink and Frost accents
    light: {
      background: '#eceff4',
      foreground: '#2e3440',
      card: '#e5e9f0',
      popover: '#f2f4f8',
      primary: '#2e3440',
      'primary-foreground': '#eceff4',
      secondary: '#e5e9f0',
      muted: '#e5e9f0',
      'muted-foreground': '#4c566a',
      accent: '#d8dee9',
      destructive: '#bf616a',
      border: '#d8dee9',
      input: '#c2cad8',
      ring: '#5e81ac80',
      brand: '#5e81ac',
      'brand-foreground': '#ffffff',
      success: '#6a8a52',
      warning: '#c0703f',
      note: '#d9b25f',
      error: '#bf616a',
      'diff-add': '#6a8a52',
      'diff-del': '#bf616a',
      terminal: '#e5e9f0',
      sidebar: '#e5e9f0',
    },
  },
  gruvbox: {
    label: 'Gruvbox',
    dark: {
      background: '#282828',
      foreground: '#ebdbb2',
      card: '#32302f',
      popover: '#3c3836',
      primary: '#ebdbb2',
      'primary-foreground': '#282828',
      secondary: '#3c3836',
      muted: '#3c3836',
      'muted-foreground': '#bdae93',
      accent: '#504945',
      destructive: '#fb4934',
      border: '#504945',
      input: '#665c54',
      ring: '#fe801980',
      brand: '#fe8019',
      'brand-foreground': '#1d2021',
      success: '#b8bb26',
      warning: '#fabd2f',
      note: '#fabd2f',
      error: '#fb4934',
      'diff-add': '#b8bb26',
      'diff-del': '#fb4934',
      terminal: '#1d2021',
      sidebar: '#22201e',
    },
    light: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      card: '#f9f5d7',
      popover: '#f9f5d7',
      primary: '#3c3836',
      'primary-foreground': '#fbf1c7',
      secondary: '#ebdbb2',
      muted: '#ebdbb2',
      'muted-foreground': '#665c54',
      accent: '#d5c4a1',
      destructive: '#cc241d',
      border: '#d5c4a1',
      input: '#bdae93',
      ring: '#d65d0e66',
      brand: '#d65d0e',
      'brand-foreground': '#ffffff',
      success: '#79740e',
      warning: '#b57614',
      note: '#b57614',
      error: '#cc241d',
      'diff-add': '#79740e',
      'diff-del': '#cc241d',
      terminal: '#ebdbb2',
      sidebar: '#f2e5bc',
    },
  },
}

// Colour math: OKLCH ⇄ linear sRGB (Björn Ottosson's OKLab), WCAG 2 relative luminance.

const round = (value: number, digits: number) => Number(value.toFixed(digits))

const oklchCss = ([l, c, h]: Lch, alpha?: number) =>
  `oklch(${round(l, 3)} ${round(c, 3)} ${round(h, 1)}${alpha === undefined ? '' : ` / ${alpha}`})`

function linearFromLch([l, c, h]: Lch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const lms = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3)
  const [x, y, z] = lms as [number, number, number]
  const clip = (v: number) => Math.min(1, Math.max(0, v))
  return [
    clip(4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z),
    clip(-1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z),
    clip(-0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z),
  ]
}

function lchFromLinear([r, g, b]: [number, number, number]): Lch {
  const [l, m, s] = [
    0.4122214708 * r + 0.5363026953 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt) as [number, number, number]
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i
const OKLCH = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/

/** A token's colour as OKLCH and its alpha; the token values here are only `#rrggbb[aa]` and `oklch(…)`. */
function parse(css: string): { lch: Lch; alpha?: number } {
  const hex = HEX.exec(css)
  if (hex) {
    const n = Number.parseInt(hex[1], 16)
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255))
    return {
      lch: lchFromLinear(rgb as [number, number, number]),
      alpha: hex[2] === undefined ? undefined : round(Number.parseInt(hex[2], 16) / 255, 2),
    }
  }
  const lch = OKLCH.exec(css)
  if (!lch) throw new Error(`Not a theme colour: ${css}`)
  return {
    lch: [Number(lch[1]), Number(lch[2]), Number(lch[3])],
    alpha: lch[4] === undefined ? undefined : Number(lch[4]),
  }
}

const luminance = (lch: Lch) => {
  const [r, g, b] = linearFromLch(lch)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: Lch, b: Lch) => {
  const [x, y] = [luminance(a), luminance(b)].toSorted((m, n) => n - m) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

const hexOf = (lch: Lch) =>
  `#${linearFromLch(lch)
    .map((v) =>
      Math.round(toGamma(v) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

// Palettes.

const accentLch = (accent: Lch | string): Lch =>
  typeof accent === 'string' ? parse(accent).lch : accent

function generate(spec: Generated, polarity: Polarity): Tokens {
  const ladder = LADDERS[spec.contrast][polarity]
  const tint = polarity === 'light' ? spec.tint * 0.6 : spec.tint
  const tokens: Tokens = {}
  for (const [name, l] of Object.entries(ladder)) {
    const ink = name === 'foreground' || name === 'primary'
    const chroma = ink ? tint * 0.5 : name === 'muted-foreground' ? tint * 1.2 : tint
    tokens[name] = oklchCss([l, chroma, spec.hue])
  }
  const states = spec.contrast === 'high' ? HIGH_STATES[polarity] : ULTIMATE[polarity]
  for (const name of STATES) tokens[name] = states[name]
  tokens.brand = oklchCss(accentLch(spec.accent[polarity]))
  return tokens
}

/** Near-white or near-black in the brand's hue, whichever reads better on it. */
function brandForeground(brand: Lch): Lch {
  const light: Lch = [0.98, 0.01, brand[2]]
  const dark: Lch = [0.2, 0.03, brand[2]]
  return contrast(light, brand) >= contrast(dark, brand) ? light : dark
}

const CHECKS = (high: boolean) =>
  [
    ['foreground', 'background', high ? 7 : 4.5],
    ['muted-foreground', 'background', high ? 7 : 4.5],
    ['muted-foreground', 'card', high ? 7 : 4.5],
    ['brand', 'background', high ? 7 : 4.5],
    ['brand-foreground', 'brand', high ? 7 : 4.5],
    ['success', 'background', 3],
    ['warning', 'background', 3],
    ['error', 'background', 3],
  ] as const

/**
 * Check every pair and, unless `fixed`, move each failing text colour's lightness away from its background in 0.01
 * steps until it passes. The brand is settled before the text on it; a derived brand foreground and ring follow it.
 */
function settle(
  tokens: Tokens,
  polarity: Polarity,
  high: boolean,
  fixed: boolean,
  derive: boolean,
) {
  const lch: Record<string, Lch> = {}
  for (const [name, value] of Object.entries(tokens)) lch[name] = parse(value).lch
  const checks: Check[] = []
  const step = polarity === 'dark' ? 0.01 : -0.01
  for (const [text, background, min] of CHECKS(high)) {
    if (text === 'brand-foreground' && derive) {
      lch[text] = brandForeground(lch.brand)
      tokens[text] = oklchCss(lch[text])
    }
    let color = lch[text]
    // On the brand, the text moves away from it, whichever way that is.
    const away =
      text === 'brand-foreground' ? (luminance(color) > luminance(lch.brand) ? 0.01 : -0.01) : step
    const others = CHECKS(high).filter(([t, b]) => t === text && b !== background)
    const passes = (candidate: Lch) =>
      contrast(candidate, lch[background]) >= min &&
      others.every(([, b, m]) => contrast(candidate, lch[b]) >= m)
    let adjusted = false
    // Each step is judged as the token will be written, rounded, until it passes or lightness runs out.
    if (!fixed)
      while (!passes(color) && color[0] + away >= 0 && color[0] + away <= 1) {
        tokens[text] = oklchCss([color[0] + away, color[1], color[2]])
        color = parse(tokens[text]).lch
        lch[text] = color
        adjusted = true
      }
    checks.push({
      pair: `${text}/${background}`,
      ratio: round(contrast(color, lch[background]), 2),
      min,
      adjusted,
    })
  }
  if (derive) {
    const [l, c, h] = lch.brand
    tokens.ring = oklchCss([l, c, h], polarity === 'dark' ? 0.5 : 0.55)
  }
  return checks
}

function custom(choice: ThemeChoice, polarity: Polarity): Tokens {
  const base = parse(ULTIMATE[polarity].background).lch
  return generate(
    {
      hue: choice.hue ?? base[2],
      tint: choice.tint ?? 0.004,
      contrast: choice.contrast ?? 'normal',
      accent: {
        dark: choice.accent ?? ULTIMATE.dark.brand,
        light: choice.accent ?? ULTIMATE.light.brand,
      },
    },
    polarity,
  )
}

/** `choice` in `polarity`: every base token, the browser-bar colour and the readability checks. */
export function resolveTheme(choice: ThemeChoice, polarity: Polarity): Resolved {
  const { preset } = choice
  const generated = GENERATED[preset]
  const tuned = TUNED[preset]
  const reference = !generated && !tuned && preset !== 'custom'
  const vars = generated
    ? generate(generated, polarity)
    : tuned
      ? { ...tuned[polarity] }
      : preset === 'custom'
        ? custom(choice, polarity)
        : { ...ULTIMATE[polarity] }
  const high =
    (generated?.contrast ?? (preset === 'custom' ? choice.contrast : 'normal')) === 'high'
  const checks = settle(vars, polarity, high, reference, Boolean(generated) || preset === 'custom')
  return {
    vars,
    themeColor: reference
      ? polarity === 'dark'
        ? '#111112'
        : '#f9fafb'
      : hexOf(parse(vars.background).lch),
    checks,
  }
}

const swatches = (id: string): Preset['swatches'] => {
  const of = (polarity: Polarity) => {
    const { vars } = resolveTheme({ preset: id }, polarity)
    return [vars.background, vars.card, vars.foreground, vars.brand] as [
      string,
      string,
      string,
      string,
    ]
  }
  return { dark: of('dark'), light: of('light') }
}

export const PRESETS: readonly Preset[] = [
  { id: 'ultimate', label: 'Ultimate' },
  ...Object.entries(GENERATED).map(([id, { label }]) => ({ id, label })),
  ...Object.entries(TUNED).map(([id, { label }]) => ({ id, label })),
].map((preset) => ({ ...preset, swatches: swatches(preset.id) }))

const known = (id: unknown, lists: readonly { id: string }[]) =>
  typeof id === 'string' && lists.some((entry) => entry.id === id) ? id : undefined

/**
 * A stored or submitted value as a choice, undefined when it is not one: an unknown preset, an accent that is not
 * `#rrggbb`, a non-numeric hue or tint, an unknown contrast. Hue wraps into 0–360, tint clamps to 0–0.04, and font
 * ids outside `UI_FONTS` and `CODE_FONTS` are dropped.
 */
export function parseChoice(value: unknown): ThemeChoice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const {
    preset,
    accent,
    hue,
    tint,
    contrast: level,
    uiFont,
    codeFont,
  } = value as Record<string, unknown>
  if (preset !== 'custom' && !PRESETS.some((entry) => entry.id === preset)) return undefined
  if (accent !== undefined && (typeof accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(accent)))
    return undefined
  const finite = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v))
  if (!finite(hue) || !finite(tint)) return undefined
  if (level !== undefined && level !== 'normal' && level !== 'high') return undefined
  const choice: ThemeChoice = { preset: preset as string }
  if (accent !== undefined) choice.accent = accent.toLowerCase()
  if (hue !== undefined) choice.hue = round((((hue as number) % 360) + 360) % 360, 1)
  if (tint !== undefined) choice.tint = round(Math.min(0.04, Math.max(0, tint as number)), 3)
  if (level !== undefined) choice.contrast = level
  const ui = known(uiFont, UI_FONTS)
  const code = known(codeFont, CODE_FONTS)
  if (ui) choice.uiFont = ui
  if (code) choice.codeFont = code
  return choice
}
