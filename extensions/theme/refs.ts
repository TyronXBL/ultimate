/** Theme in the browser: this machine's theme choice and the action that sets it. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** The machine's theme choice, stored as `theme` in `~/.ultimate/settings.json`; `palette.ts` resolves it. */
export type ThemeChoice = {
  /** A preset id (`PRESETS`), or `custom`. */
  preset: string
  /** `custom`: the accent, `#rrggbb`. Kept under other presets, so switching back to custom restores it. */
  accent?: string
  /** `custom`: the base hue in degrees, 0–360. */
  hue?: number
  /** `custom`: how strongly the base takes the hue, an OKLCH chroma from 0 to 0.04. */
  tint?: number
  /** `custom`: high contrast. */
  contrast?: 'normal' | 'high'
  /** A `UI_FONTS` id. */
  uiFont?: string
  /** A `CODE_FONTS` id. */
  codeFont?: string
}

/** On conversation 1: the machine's theme choice, mirrored from `theme` in `~/.ultimate/settings.json`. */
export const ThemeDoc = docRef<{ choice?: ThemeChoice }>('theme.choice')
/**
 * A `ThemeChoice` → the choice as saved: validated, written to `theme` in the user's settings and mirrored into
 * `ThemeDoc`, so every browser on this machine repaints. Refuses an unknown preset or a malformed colour.
 */
export const SetAction = actionRef<ThemeChoice, ThemeChoice>('theme', 'set')
