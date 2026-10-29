import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ActionContext } from '../server/actions.ts'
import { actions, docs } from '../extensions/theme/server.ts'
import { parseChoice, PRESETS, resolveTheme } from '../extensions/theme/palette.ts'
import { removeTemps, temp } from './helpers.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  await removeTemps()
})

/** The base tokens of one block of `web/src/index.css`: every `--name: value` that is not a `var()` or the radius. */
function block(css: string, selector: string) {
  const body = css.slice(css.indexOf(`${selector} {`)).split('}')[0]
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+): ([^;]+);/g)]
      .filter(([, name, value]) => name !== 'radius' && !value.startsWith('var('))
      .map(([, name, value]) => [name, value]),
  )
}

it('keeps the default theme exactly as index.css paints it', async () => {
  const css = await readFile(join(import.meta.dirname, '../web/src/index.css'), 'utf8')
  expect(resolveTheme({ preset: 'ultimate' }, 'light').vars).toEqual(block(css, ':root'))
  expect(resolveTheme({ preset: 'ultimate' }, 'dark').vars).toEqual(block(css, '.dark'))
})

it('makes every preset and a hard custom accent readable in both polarities', () => {
  const choices = [
    ...PRESETS.filter((preset) => preset.id !== 'ultimate').map((preset) => ({
      preset: preset.id,
    })),
    // Pure yellow reads on dark but not on a light background.
    { preset: 'custom', accent: '#ffff00', hue: 30, tint: 0.03 },
    // Black starts at lightness 0 and must still be lifted on dark.
    { preset: 'custom', accent: '#000000' },
  ]
  for (const choice of choices)
    for (const polarity of ['dark', 'light'] as const)
      for (const check of resolveTheme(choice, polarity).checks)
        expect(check.ratio, `${choice.preset} ${polarity} ${check.pair}`).toBeGreaterThanOrEqual(
          check.min,
        )
  const brand = resolveTheme({ preset: 'custom', accent: '#ffff00' }, 'light').checks.find(
    (check) => check.pair === 'brand/background',
  )
  expect(brand?.adjusted).toBe(true)
})

it('rejects what is not a theme choice', () => {
  expect(parseChoice({ preset: 'custom', accent: 'red' })).toBeUndefined()
  expect(parseChoice({ preset: 'custom', accent: '#FF8800', hue: 400, tint: 1 })).toEqual({
    preset: 'custom',
    accent: '#ff8800',
    hue: 40,
    tint: 0.04,
  })
})

it('saves a choice to the user settings and the document every browser streams', async () => {
  const userHome = await temp('ultimate-theme-')
  const prepared = await prepareHarness({
    ultimateRoot: userHome,
    userHome,
    home: userHome,
    faux: fauxProvider({ models: [{ id: 'faux-1' }] }),
  })
  const opened = await prepared.open(false)
  hosts.push(opened)
  const ctx = {
    host: {
      userHome,
      harness: () => opened.harness,
      notice: () => {},
      resource: <T>(_key: string, create: () => T) => create(),
    },
  } as unknown as ActionContext
  const settings = join(userHome, '.ultimate/settings.json')

  await expect(actions.set({ preset: 'nope' }, ctx)).rejects.toThrow('Not a theme choice')
  await expect(readFile(settings, 'utf8')).rejects.toThrow('ENOENT')

  await actions.set({ preset: 'nord', codeFont: 'hack' }, ctx)
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({
    theme: { preset: 'nord', codeFont: 'hack' },
  })
  expect(await opened.harness.snapshot(docs[0], ROOT_CONVERSATION_ID, context)).toEqual({
    choice: { preset: 'nord', codeFont: 'hack' },
  })
})
