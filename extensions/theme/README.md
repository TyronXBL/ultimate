Colour themes and fonts, one choice per machine, light or dark per device.

- **The choice** (`ThemeChoice` in `refs.ts`) is a preset, or `custom` with an accent, a base hue and tint and normal or
  high contrast, plus a UI and a code font. It lives in `theme` of `~/.ultimate/settings.json`, so every project on the
  machine shares it. The `set` action validates it, writes it there and mirrors it into the `theme.choice` document on
  conversation 1; the server also mirrors the file on start and whenever it changes, so a hand edit or another
  project's server reaches every browser too.
- **Palettes** (`palette.ts`, pure): Ultimate's own tokens as `web/src/index.css` defines them; generated presets
  (Midnight, Ember, Sage, High contrast) built from a base hue, tint, lightness ladder and accent; hand-tuned
  Catppuccin, Nord and Gruvbox. Every preset has a dark and a light side. `resolveTheme(choice, polarity)` checks each
  text colour against its background (WCAG 2: 4.5:1 for text, 7:1 in high contrast, 3:1 for state colours) and moves
  a failing one's OKLCH lightness until it passes; Ultimate's tokens are only reported, never moved.
- **Light or dark** is each device's own: `ui.themeMode` is `system` (the default, following
  `prefers-color-scheme`) or an explicit `light`/`dark` kept in that browser's `localStorage` (`ultimate.theme`).
  `context.setTheme('light' | 'dark' | 'system')` sets it; the palette has "Toggle light and dark theme" and "Follow
  the system light or dark setting".
- **Painting**: an `overlay` component sets the resolved tokens, fonts and `theme-color` on `<html>` and caches both
  polarities in `localStorage` (`ultimate.theme.cache`), which `web/index.html` applies before the app loads, so a
  reload paints the theme at once. It paints nothing until the doc arrives, so the cached palette stays meanwhile.
- **The picker** (`appearance.tsx`): ⌘K "Appearance…" or the status line's `theme` item (in its ⋯ menu on a
  phone) opens a non-modal panel, a bottom sheet on a phone, with this device's mode, the preset tiles, the custom
  controls with the readability adjustments the engine made, and the fonts (ones this device lacks are disabled).
  Taps save at once; sliders and the colour well preview a draft on this page only and save on release.
