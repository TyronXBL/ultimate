import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readUsage } from '../lib/job-scope.ts'
import { temp } from './helpers.ts'

it.each([
  [
    'a finished job: peak bytes, CPU microseconds, no kill',
    '1610612736 45200000 0\n',
    { peakMiB: 1536, cpuSeconds: 45, limitMiB: 4400, oomKilled: false },
  ],
  [
    'a job the kernel killed at its limit',
    '4613734400 3000000 1\n',
    { peakMiB: 4400, cpuSeconds: 3, limitMiB: 4400, oomKilled: true },
  ],
  ['a record cut short', '1610612736 \n', undefined],
  ['no record: stopped before its command ended', undefined, undefined],
])('reads what a job scope recorded: %s', async (_name, text, usage) => {
  const file = join(await temp('ultimate-job-scope-'), 'job.usage')
  if (text !== undefined) await writeFile(file, text)
  expect(await readUsage(file, 2200)).toEqual(usage)
})
