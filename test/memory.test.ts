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
    expect(ramShort(available, need, floor, reserved)).toEqual(
      short ? { available, need, floor, ...(reserved && { reserved }) } : undefined,
    )
  },
)

it('reserves what it admits, so concurrent starters cannot both pass on the same RAM', async () => {
  const dir = await temp('ultimate-memory-')
  // Room for exactly one 1024 MiB job above the floor, while RAM moves less than 400 MiB during the test.
  const floor = (await availableMiB())! - 1500
  const admitted = await Promise.all([1, 2, 3].map(() => admitRam(floor, 1024, dir)))
  expect(admitted.filter((short) => short === undefined)).toHaveLength(1)
  expect(admitted.find(Boolean)).toMatchObject({ need: 1024, reserved: 1024 })
})

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
