import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { list, startProject } from '../extensions/projects/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { projects as readProjects } from '../server/project.ts'

const homes: string[] = []
afterAll(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** A host that reads real homes, as the server's does, with this process absent from the tailnet. */
function host(userHome: string, projectRoot: string, home: string) {
  const resources = new Map<string, unknown>()
  return {
    userHome,
    projectRoot,
    ultimateRoot: resolve('.'),
    home,
    projects: () => readProjects(userHome, home),
    resource: <T>(key: string, create: () => T) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    want: () => undefined,
  } as unknown as ExtensionHost
}

/** A home in `~/.ultimate/projects`, with its manifest, lock and conversation index as a project leaves them. */
async function writeHome(directory: string, files: Record<string, unknown> = {}) {
  await mkdir(directory, { recursive: true })
  for (const [name, value] of Object.entries(files))
    await writeFile(join(directory, name), JSON.stringify(value))
}

it('lists this machine’s projects, this one first and then by name, with their remotes', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'ultimate-projects-'))
  homes.push(userHome)
  const directory = join(userHome, '.ultimate/projects')
  // A project opened before: its manifest, a live supervisor and the conversations people wrote to.
  await writeHome(join(directory, 'alpha-11111111'), {
    'project.json': { root: '/work/alpha', name: 'alpha', openedAt: 1 },
    'ultimate.lock': { pid: process.pid, port: 4747 },
    'conversations.json': [
      { id: 1, inputAt: 100, answerAt: 200 },
      { id: 2, inputAt: 300 },
    ],
  })
  // This server's own home, without a manifest, so its name is the home directory's.
  const current = join(directory, 'beta-22222222')
  await writeHome(current, { 'conversations.json': [] })
  await writeFile(
    join(userHome, '.ultimate/settings.json'),
    JSON.stringify({ remotes: { studio: { site: 'https://site.tail1.ts.net' } } }),
  )

  expect(await list(host(userHome, '/work/alpha', current))).toEqual({
    projects: [
      { name: 'beta-22222222', current: true },
      {
        name: 'alpha',
        root: '/work/alpha',
        current: false,
        url: 'http://127.0.0.1:4747',
        activeAt: 300,
      },
    ],
    remotes: [{ machine: 'studio', name: 'site', url: 'https://site.tail1.ts.net' }],
  })
})

it('refuses to start a relative path, a missing folder and the project it already runs', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'ultimate-projects-'))
  homes.push(userHome)
  const current = join(userHome, 'project')
  await mkdir(join(userHome, '.ultimate/projects'), { recursive: true })
  await mkdir(current)
  const fake = host(userHome, current, join(userHome, '.ultimate/projects/current-00000000'))

  await expect(startProject(fake, 'project/app')).rejects.toThrow(
    'project/app is not an absolute path; use ~/ or /',
  )
  await expect(startProject(fake, join(userHome, 'missing'))).rejects.toThrow(
    `No folder at ${join(userHome, 'missing')}`,
  )
  await expect(startProject(fake, current)).rejects.toThrow(
    'This is the project this Ultimate runs; open another folder',
  )
})
