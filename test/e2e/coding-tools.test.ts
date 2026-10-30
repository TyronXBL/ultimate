import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import codingTools from '../../extensions/coding-tools/server.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, temp, removeTemp } from '../helpers.ts'

const run = promisify(execFile)

it('stops default bash at the tripwire, kills its process, and preserves explicit timeout errors', async () => {
  vi.stubEnv('ULTIMATE_BASH_TIMEOUT', '0.1')
  const directory = await temp('ultimate-bash-tripwire-')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    home: join(directory, 'home'),
    userHome: directory,
  })
  try {
    const pidFile = join(directory, 'pid')
    for (const explicit of [false, true]) {
      server.host.faux!.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('bash', {
              command: `echo $$ > '${pidFile}'; sleep 10`,
              ...(explicit ? { timeout: 0.2 } : {}),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Complete'),
      ])
      const started = performance.now()
      await (await server.root.submit({ type: 'input', content: 'Run' }, context)).wait(context)
      expect(performance.now() - started).toBeLessThan(4000)
      const view = await server.root.viewState(context)
      try {
        const result = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result').at(-1)
          ?.model?.[0]
        expect(result?.role === 'toolResult' && result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain(
          explicit
            ? 'Command timed out after 0.2 seconds'
            : 'Tripwire: bash ran past the 0.1 s default limit',
        )
        expect(JSON.stringify(result).includes('Tripwire:')).toBe(!explicit)
      } finally {
        view.dispose()
      }
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow('ESRCH')
    }
  } finally {
    vi.unstubAllEnvs()
    await server.close()
    await removeTemp(directory)
  }
})

it('reads a file as committed at a revision, after the working tree dropped it', async () => {
  const cwd = await temp('ultimate-read-rev-')
  const git = (...args: string[]) => run('git', args, { cwd })
  try {
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Read Test')
    await git('config', 'user.email', 'read@example.test')
    await mkdir(join(cwd, 'notes'))
    await writeFile(join(cwd, 'notes', 'a.txt'), 'one\ntwo\nthree\n')
    await copyFile(resolve('web/public/icons/icon-180.png'), join(cwd, 'notes', 'icon.png'))
    await git('add', '.')
    await git('commit', '-m', 'add')
    const added = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('rm', '-r', 'notes')
    await git('commit', '-m', 'remove')
    const read = codingTools({
      emit: vi.fn<ExtensionHost['emit']>() as ExtensionHost['emit'],
    }).tools!.find((tool) => tool.name === 'read')!
    const api = {
      env: new NodeExecutionEnv({ cwd }),
      agent: async () => ({}),
    } as unknown as ToolExecutionApi
    const result = await read.execute(
      { path: 'notes/a.txt', rev: added, offset: 2, limit: 1 },
      api,
      context,
    )
    expect(result.output).toEqual([{ type: 'text', text: 'two' }])
    expect(result.diagnostics?.[0].message).toBe('2 more lines in file. Use offset=3 to continue.')
    // The image processor transfers the bytes to its worker, which a Node Buffer would refuse.
    const image = await read.execute({ path: 'notes/icon.png', rev: added }, api, context)
    expect(image.output).toEqual([
      expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
    ])
    await expect(read.execute({ path: 'notes/a.txt', rev: 'HEAD' }, api, context)).rejects.toThrow(
      'notes/a.txt does not exist at HEAD',
    )
    await expect(read.execute({ path: 'notes/a.txt', rev: 'nope' }, api, context)).rejects.toThrow(
      'Unknown revision nope',
    )
  } finally {
    await removeTemp(cwd)
  }
})
