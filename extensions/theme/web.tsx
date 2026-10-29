import { useEffect, useMemo } from 'react'
import { defineWebExtension, getState, useDocOf, useStore } from '@/sdk'
import { CODE_FONTS, fontCss, UI_FONTS } from './fonts.ts'
import { DEFAULT_CHOICE, resolveTheme } from './palette.ts'
import type { Polarity, Resolved } from './palette.ts'
import { ThemeDoc } from './refs.ts'

/** What `web/index.html` paints before the app loads: both polarities, so the device's system setting picks. */
export type ThemeCache = Record<Polarity, Pick<Resolved, 'vars' | 'themeColor'>> & {
  sans: string
  mono: string
}
const CACHE = 'ultimate.theme.cache'

/** The token vars this facet put on <html>, so a theme with fewer tokens leaves none of the last one behind. */
let applied: string[] = []

/** Paint the machine's theme choice in this device's polarity, and remember it for the next first paint. */
function ApplyTheme() {
  const choice = useDocOf(1, ThemeDoc)?.choice ?? DEFAULT_CHOICE
  const polarity = useStore((state) => state.ui.theme)
  const key = JSON.stringify(choice)
  const cache = useMemo<ThemeCache>(() => {
    const parsed = JSON.parse(key) as typeof choice
    const pick = ({ vars, themeColor }: Resolved) => ({ vars, themeColor })
    return {
      dark: pick(resolveTheme(parsed, 'dark')),
      light: pick(resolveTheme(parsed, 'light')),
      sans: fontCss(UI_FONTS, parsed.uiFont),
      mono: fontCss(CODE_FONTS, parsed.codeFont),
    }
  }, [key])
  useEffect(() => {
    const { style } = document.documentElement
    const { vars, themeColor } = cache[polarity]
    for (const name of applied) style.removeProperty(name)
    applied = [...Object.keys(vars).map((name) => `--${name}`), '--font-sans', '--font-mono']
    for (const [name, value] of Object.entries(vars)) style.setProperty(`--${name}`, value)
    style.setProperty('--font-sans', cache.sans)
    style.setProperty('--font-mono', cache.mono)
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', themeColor)
    localStorage.setItem(CACHE, JSON.stringify(cache))
  }, [cache, polarity])
  return null
}

export default defineWebExtension({
  slots: { overlay: [ApplyTheme] },
  commands: [
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
