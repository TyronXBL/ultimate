import { useEffect, useMemo } from 'react'
import { defineWebExtension, getState, useDocOf, useStore } from '@/sdk'
import {
  AppearanceButton,
  AppearanceDialog,
  appearanceDialog,
  settleDraft,
  useDraft,
} from './appearance.tsx'
import { CODE_FONTS, fontCss, UI_FONTS } from './fonts.ts'
import { DEFAULT_CHOICE, resolveTheme } from './palette.ts'
import type { Polarity, Resolved } from './palette.ts'
import type { ThemeChoice } from './refs.ts'
import { ThemeDoc } from './refs.ts'

/** What `web/index.html` paints before the app loads: both polarities, so the device's system setting picks. */
export type ThemeCache = Record<Polarity, Pick<Resolved, 'vars' | 'themeColor'>> & {
  sans: string
  mono: string
}
const CACHE = 'ultimate.theme.cache'

/** `choice` resolved for both polarities, memoized by its content. */
function useResolved(choice: ThemeChoice) {
  const key = JSON.stringify(choice)
  return useMemo<ThemeCache>(() => {
    const parsed = JSON.parse(key) as ThemeChoice
    const pick = ({ vars, themeColor }: Resolved) => ({ vars, themeColor })
    return {
      dark: pick(resolveTheme(parsed, 'dark')),
      light: pick(resolveTheme(parsed, 'light')),
      sans: fontCss(UI_FONTS, parsed.uiFont),
      mono: fontCss(CODE_FONTS, parsed.codeFont),
    }
  }, [key])
}

/**
 * Paint the machine's theme choice in this device's polarity, and remember it for the next first paint. Until the
 * doc arrives, the page keeps what `web/index.html` painted from the cache; a missing doc means the default.
 */
function ApplyTheme() {
  const doc = useDocOf(1, ThemeDoc)
  return doc === undefined ? null : <Paint saved={doc?.choice ?? DEFAULT_CHOICE} />
}

/** While the Appearance picker holds an unsaved draft, this page paints the draft; the cache keeps the saved choice. */
function Paint({ saved }: { saved: ThemeChoice }) {
  const draft = useDraft()
  const polarity = useStore((state) => state.ui.theme)
  const cache = useResolved(saved)
  const shown = useResolved(draft ?? saved)
  useEffect(() => settleDraft(saved), [saved, draft])
  useEffect(() => {
    const { style } = document.documentElement
    const { vars, themeColor } = shown[polarity]
    for (const [name, value] of Object.entries(vars)) style.setProperty(`--${name}`, value)
    style.setProperty('--font-sans', shown.sans)
    style.setProperty('--font-mono', shown.mono)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', themeColor)
  }, [shown, polarity])
  useEffect(() => localStorage.setItem(CACHE, JSON.stringify(cache)), [cache])
  return null
}

export default defineWebExtension({
  slots: {
    overlay: [ApplyTheme, AppearanceDialog],
    'statusline.right': [{ component: AppearanceButton, order: -1 }],
  },
  commands: [
    {
      id: 'theme.appearance',
      title: 'Appearance…',
      group: 'Ultimate',
      run: (context) => context.open(appearanceDialog),
    },
    {
      id: 'theme.toggle',
      title: 'Toggle light and dark theme',
      group: 'Ultimate',
      run: (context) => context.setTheme(getState().ui.theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'theme.system',
      title: 'Follow the system light or dark setting',
      group: 'Ultimate',
      when: () => getState().ui.themeMode !== 'system',
      run: (context) => context.setTheme('system'),
    },
  ],
})
