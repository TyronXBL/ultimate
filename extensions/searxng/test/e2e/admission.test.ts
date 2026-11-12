import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

it('drops claims of processes that are gone', async () => {
  home = await temp()
  await (
    await admitSearch(home)
  )()
  const db = new DatabaseSync(join(home, '.ultimate/web-search-admission.sqlite'))
  // Two claims left by a crashed host: a pid that does not exist, and a reused pid with another start time.
  db.prepare('INSERT INTO holders VALUES (?, ?, ?)').run('crashed', 2 ** 22 + 1, 'gone')
  db.prepare('INSERT INTO holders VALUES (?, ?, ?)').run('reused', process.pid, 'other start')
  db.close()
  const release = await admitSearch(home, AbortSignal.timeout(1000))
  const after = new DatabaseSync(join(home, '.ultimate/web-search-admission.sqlite'))
  expect(after.prepare('SELECT count(*) AS n FROM holders').get()).toEqual({ n: 1 })
  after.close()
  await release()
})

it('reserves distinct monthly credits across concurrent host processes', async () => {
  home = await temp()
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
