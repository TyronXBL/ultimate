import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { temp } from '../helpers.ts'

const run = promisify(execFile)
const runner = join(import.meta.dirname, '../../.ultimate/scripts/remote-job.ts')

/**
 * A checkout with one commit (a tracked `notes.txt`), and the project's runner started in it against a host whose ssh
 * is a stand-in that only records that it was called: `sent` says whether anything left for the host.
 */
async function checkout() {
  const dir = await temp('ultimate-remote-job-')
  const git = (...args: string[]) => run('git', args, { cwd: dir })
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'dev@example.com')
  await git('config', 'user.name', 'Dev')
  await writeFile(join(dir, 'notes.txt'), 'TOKEN=abc\nHOST=example.com\nPORT=1\n')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'first')
  const calls = join(await temp(), 'ssh-calls')
  const ssh = join(await temp(), 'ssh')
  await writeFile(ssh, `#!/bin/sh\necho called >> ${calls}\nexit 1\n`)
  await chmod(ssh, 0o755)
  const status = join(await temp(), 'status.json')
  return {
    dir,
    git,
    job: async () => {
      await rm(calls, { force: true })
      await run(process.execPath, [runner], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: ssh,
          ULTIMATE_REMOTE_HOST: 'my-pc',
          ULTIMATE_REMOTE_COMMAND: 'pnpm check',
          ULTIMATE_REMOTE_STATUS: status,
        },
      }).catch(
        // The runner exits non-zero whenever the command did not run there; its status file says why.
        () => undefined,
      )
      return {
        status: JSON.parse(await readFile(status, 'utf8')) as { ran: boolean; reason?: string },
        sent: existsSync(calls),
      }
    },
  }
}

it('sends a changed checkout, and nothing once a new file looks like a secret: untracked, staged, or in place of a deleted one', async () => {
  const { dir, git, job } = await checkout()
  // An edit and a new file: the snapshot goes out (the stand-in ssh then fails the push).
  await writeFile(join(dir, 'new.ts'), 'export const one = 1\n')
  expect(await job()).toMatchObject({ status: { ran: false }, sent: true })
  // Untracked.
  await writeFile(join(dir, '.env'), 'TOKEN=abc\n')
  expect(await job()).toEqual({
    status: { ran: false, reason: 'new file .env looks like a secret' },
    sent: false,
  })
  // Staged: no longer among the untracked files.
  await git('add', '.env')
  expect((await job()).sent).toBe(false)
  // With the same content as a tracked file deleted beside it, which git would call a rename, not an addition.
  await git('rm', '-q', '--cached', '.env')
  await rm(join(dir, '.env'))
  await git('mv', 'notes.txt', 'server.key')
  expect(await job()).toEqual({
    status: { ran: false, reason: 'new file server.key looks like a secret' },
    sent: false,
  })
  // The checkout is as the test left it: the runner works on a copy of the index.
  expect((await git('status', '--porcelain')).stdout).toBe(
    'R  notes.txt -> server.key\n?? new.ts\n',
  )
})
