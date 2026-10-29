/** UI and code font choices, browser-safe. Contract stub: E1.1 fills the lists. */

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

export const UI_FONTS: readonly Font[] = [{ id: 'inter', label: 'Inter', css: SANS, local: [] }]
export const CODE_FONTS: readonly Font[] = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', css: MONO, local: [] },
]

/** The `font-family` stack of `id` in `fonts`, the first one when `id` is unknown or unset. */
export const fontCss = (fonts: readonly Font[], id: string | undefined) =>
  (fonts.find((font) => font.id === id) ?? fonts[0]).css
