import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { lockfileInstalled } from '../lib/packages.ts'
import { temp } from './helpers.ts'

// The lander lets an install of an already installed lockfile run without the heavy-work slot (#273712): only a
// lockfile pnpm installed exactly may count, never a missing one.
it.each<[string, string | undefined, string | undefined, boolean]>([
  ['the lockfile pnpm installed', 'a', 'a', true],
  ['a lockfile that differs from the installed one', 'b', 'a', false],
  ['no lockfile', undefined, 'a', false],
  ['a lockfile never installed', 'a', undefined, false],
])(
  'tells whether the lockfile is installed with %s',
  async (_case, wanted, installed, expected) => {
    const root = await temp('ultimate-packages-')
    if (wanted !== undefined) await writeFile(join(root, 'pnpm-lock.yaml'), wanted)
    if (installed !== undefined) {
      await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true })
      await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), installed)
    }
    expect(await lockfileInstalled(root)).toBe(expected)
  },
)
