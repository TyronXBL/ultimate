import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { reserveSearch } from '../../budget.ts'
import { admitSearch } from '../../admission.ts'
import { removeTemp, temp } from '../../../../test/helpers.ts'

const exec = promisify(execFile)

let home = ''
afterEach(async () => {
  if (home) await removeTemp(home)
})

it('shares two search slots between independent callers and admits a waiter after release', async () => {
  home = await temp()
  const [first, second] = await Promise.all([admitSearch(home), admitSearch(home)])
  let admitted = false
  const third = admitSearch(home).then((release) => {
    admitted = true
    return release
  })
  // The retry interval is 100 ms; keep both slots held over two retries.
  await new Promise<void>((resolve) => setTimeout(resolve, 250))
  expect(admitted).toBe(false)
  await first()
  const releaseThird = await third
  expect(admitted).toBe(true)
  await releaseThird()
  await second()
})

it('reserves distinct monthly credits across concurrent host processes', async () => {
  home = await temp()
  // Admission normally creates the user directory before a reservation.
  const release = await admitSearch(home)
  await release()
  expect(await reserveSearch(home)).toBe(1)
  const moduleUrl = new URL('../../budget.ts', import.meta.url).href
  const script = `import { reserveSearch } from ${JSON.stringify(moduleUrl)}; console.log(await reserveSearch(process.argv[1]))`
  const results = await Promise.all([
    exec(process.execPath, ['--input-type=module', '-e', script, home]),
    exec(process.execPath, ['--input-type=module', '-e', script, home]),
  ])
  expect(results.map((result) => Number(result.stdout.trim())).toSorted((a, b) => a - b)).toEqual([
    2, 3,
  ])
})
