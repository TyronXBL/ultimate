/** UI and code font choices, browser-safe: a font is a `font-family` stack ending in the bundled default. */

export type Font = {
  id: string
  label: string
  /** The CSS `font-family` stack. */
  css: string
  /** Families that must be installed on the device for this choice to differ from the fallback; empty when bundled. */
  local: string[]
}

const SANS = "'Inter Variable', Inter, ui-sans-serif, system-ui, sans-serif"
const MONO =
  "'JetBrains Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMono NF', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

/** A font from locally installed `families`, falling back to `fallback`. */
const local = (id: string, label: string, families: string[], fallback: string): Font => ({
  id,
  label,
  css: `${families.map((family) => `"${family}"`).join(', ')}, ${fallback}`,
  local: families,
})

export const UI_FONTS: readonly Font[] = [
  { id: 'inter', label: 'Inter', css: SANS, local: [] },
  {
    id: 'system',
    label: 'System',
    css: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    local: [],
  },
  local('dm-sans', 'DM Sans', ['DM Sans'], SANS),
  local('manrope', 'Manrope', ['Manrope'], SANS),
  local('ibm-plex-mono', 'IBM Plex Mono', ['IBM Plex Mono'], MONO),
  local('jetbrains', 'JetBrains Mono Nerd', ['JetBrainsMono Nerd Font', 'JetBrains Mono'], MONO),
  local('firacode', 'FiraCode Nerd', ['FiraCode Nerd Font', 'Fira Code'], MONO),
]

export const CODE_FONTS: readonly Font[] = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', css: MONO, local: [] },
  {
    id: 'system-mono',
    label: 'System mono',
    css: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    local: [],
  },
  local(
    'jetbrains-nl',
    'JetBrains Mono NL Nerd',
    ['JetBrainsMonoNL Nerd Font', 'JetBrains Mono NL'],
    MONO,
  ),
  local('ibm-plex-mono', 'IBM Plex Mono', ['IBM Plex Mono'], MONO),
  local('firacode', 'FiraCode Nerd', ['FiraCode Nerd Font', 'Fira Code'], MONO),
  local('hack', 'Hack Nerd', ['Hack Nerd Font', 'Hack'], MONO),
  local('mononoki', 'Mononoki Nerd', ['Mononoki Nerd Font', 'Mononoki'], MONO),
]

/** The `font-family` stack of `id` in `fonts`, the first one when `id` is unknown or unset. */
export const fontCss = (fonts: readonly Font[], id: string | undefined) =>
  (fonts.find((font) => font.id === id) ?? fonts[0]).css
