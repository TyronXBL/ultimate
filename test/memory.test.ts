import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { availableMiB, commandNeedMiB, memoryFloor, ramShort } from '../lib/memory.ts'
import { temp } from './helpers.ts'

it.each([
  { available: 5000, need: 1536, floor: 3072, short: false },
  { available: 4608, need: 1536, floor: 3072, short: false },
  { available: 4607, need: 1536, floor: 3072, short: true },
  { available: 3000, need: 0, floor: 3072, short: true },
  { available: 2000, need: 1536, floor: undefined, short: false },
  { available: undefined, need: 1536, floor: 3072, short: false },
])(
  'decides whether $need MiB fits with $available MiB available above a $floor MiB floor',
  ({ available, need, floor, short }) => {
    expect(ramShort(available, need, floor)).toEqual(short ? { available, need, floor } : undefined)
  },
)

it.each([
  ['cd app && pnpm test', 1536],
  ['nice -n 15 pnpm exec vitest run test/memory.test.ts', 1536],
  ['node server/main.ts', 1536],
  ['pnpm fix', 1024],
  ['pnpm install --frozen-lockfile --offline', 1024],
  ['rg -n "pnpm test" docs', 0],
  ["git commit -m 'run pnpm check'", 0],
  ['git status', 0],
])('estimates %s at %i MiB', (command, need) => {
  expect(commandNeedMiB(command)).toBe(need)
})

it('reads the floor from settings and MemAvailable from meminfo', async () => {
  expect(memoryFloor({})).toBeUndefined()
  expect(memoryFloor({ memory: { minAvailableMiB: 0 } })).toBeUndefined()
  expect(memoryFloor({ memory: { minAvailableMiB: 3072 } })).toBe(3072)
  const meminfo = join(await temp('ultimate-memory-'), 'meminfo')
  await writeFile(meminfo, 'MemTotal:       12238816 kB\nMemAvailable:    3029644 kB\n')
  expect(await availableMiB(meminfo)).toBe(2958)
  expect(await availableMiB(join(meminfo, 'missing'))).toBeUndefined()
})
