/** Theme for other extensions' browser code: the brand colour on screen, live. */
import { useDocOf, useStore } from '@/sdk'
import { DEFAULT_CHOICE, resolveTheme } from './palette.ts'
import { ThemeDoc } from './refs.ts'

/** The brand colour this device shows now, as CSS; it follows the machine's choice and this device's light or dark. */
export function useBrand(): string {
  const polarity = useStore((state) => state.ui.theme)
  const doc = useDocOf(1, ThemeDoc)
  // Until the machine's choice arrives, the brand the page painted first (web/index.html) is the right one.
  return doc === undefined
    ? getComputedStyle(document.documentElement).getPropertyValue('--brand')
    : resolveTheme(doc?.choice ?? DEFAULT_CHOICE, polarity).vars.brand
}
