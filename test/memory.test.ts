import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { admitRam, availableMiB, commandNeedMiB, memoryFloor, ramShort } from '../lib/memory.ts'
import { writeJson } from '../lib/json-file.ts'
import { temp } from './helpers.ts'

it.each([
  { available: 5000, need: 1536, floor: 3072, short: false },
  { available: 4608, need: 1536, floor: 3072, short: false },
  { available: 4607, need: 1536, floor: 3072, short: true },
  { available: 3000, need: 0, floor: 3072, short: true },
  { available: 2000, need: 1536, floor: undefined, short: false },
  { available: undefined, need: 1536, floor: 3072, short: false },
  { available: 6144, need: 1536, floor: 3072, reserved: 1536, short: false },
  { available: 6144, need: 1536, floor: 3072, reserved: 1537, short: true },
])(
  'decides whether $need MiB fits with $available MiB available ($reserved reserved) above a $floor MiB floor',
  ({ available, need, floor, reserved, short }) => {
    expect(ramShort({ available, cap: undefined }, need, floor, reserved)).toEqual(
      short ? { kind: 'floor', available, need, floor, ...(reserved && { reserved }) } : undefined,
    )
  },
)

/** The service's cap on 2026-11-12 (#227574): 5632 MiB soft cap. */
const cap = (used: number) => ({ used, high: 5632, pressure: { some: 0, full: 0 } })
it.each<[string, Parameters<typeof ramShort>, ReturnType<typeof ramShort>]>([
  ['fits under both', [{ available: 8000, cap: cap(3000) }, 2200, 3072], undefined],
  [
    'blocked by the floor, whatever the cap leaves',
    [{ available: 5000, cap: cap(1000) }, 2200, 3072],
    { kind: 'floor', available: 5000, need: 2200, floor: 3072 },
  ],
  [
    'blocked by the cap with RAM to spare (01:23 UTC: a second `pnpm check` beside one)',
    [{ available: 8000, cap: cap(3500) }, 2200, 3072],
    { kind: 'cap', used: 3500, high: 5632, need: 2200 },
  ],
  [
    'jobs admitted in the last minute count against the cap too',
    [{ available: 9000, cap: cap(3000) }, 1536, 3072, 1536],
    { kind: 'cap', used: 3000, high: 5632, need: 1536, reserved: 1536 },
  ],
  [
    'no cap present: the floor alone decides',
    [{ available: 8000, cap: undefined }, 2200, 3072],
    undefined,
  ],
  [
    'admission off: no floor, no cap rule either',
    [{ available: 8000, cap: cap(5600) }, 2200, undefined],
    undefined,
  ],
])('cap: %s', (_name, args, short) => {
  expect(ramShort(...args)).toEqual(short)
})

it('reserves what it admits, so concurrent starters cannot both pass on the same RAM', async () => {
  const dir = await temp('ultimate-memory-')
  // Room for exactly one 2000 MiB job above the floor.
  const read = async () => ({ available: 10_000, cap: undefined })
  const admitted = await Promise.all([1, 2, 3].map(() => admitRam(7000, 2000, dir, read)))
  expect(admitted.filter((short) => short === undefined)).toHaveLength(1)
  expect(admitted.find(Boolean)).toMatchObject({ kind: 'floor', need: 2000, reserved: 2000 })
})

it.each([
  ['cd app && pnpm test', 1536],
  ['nice -n 15 pnpm exec vitest run test/memory.test.ts', 1536],
  ['node server/main.ts', 1536],
  ['pnpm fix', 2200],
  ['pnpm check', 2200],
  ['pnpm install --frozen-lockfile --offline', 1024],
  ['rg -n "pnpm test" docs', 0],
  ["git commit -m 'run pnpm check'", 0],
  ['git status', 0],
])('estimates %s at %i MiB', (command, need) => {
  expect(commandNeedMiB(command)).toBe(need)
})

it("reads the floor from this machine's settings and MemAvailable from meminfo", async () => {
  const userHome = await temp('ultimate-memory-')
  expect(await memoryFloor(userHome)).toBeUndefined()
  await writeJson(join(userHome, '.ultimate/settings.json'), { memory: { minAvailableMiB: 3072 } })
  expect(await memoryFloor(userHome)).toBe(3072)
  const meminfo = join(userHome, 'meminfo')
  await writeFile(meminfo, 'MemTotal:       12238816 kB\nMemAvailable:    3029644 kB\n')
  expect(await availableMiB(meminfo)).toBe(2958)
  expect(await availableMiB(join(meminfo, 'missing'))).toBeUndefined()
})
