import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach } from 'vitest'
import type { Automation } from '../../types.ts'
import { context } from '../../../../server/harness.ts'
import { fauxServer, temp } from '../../../../test/helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
/** The test's server, closed when it ends; a test that reopens one tracks the new server here. */
export const tracked: { server?: Server } = {}
afterEach(async () => {
  const app = tracked.server
  tracked.server = undefined
  await app?.close()
})

export async function fixture(localSetup = true) {
  const root = await temp('ultimate-automations-')
  const userHome = join(root, 'user')
  const home = join(root, 'project-state')
  const definitions = join(userHome, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  for (const name of ['watcher', 'ultimate'])
    await writeFile(
      join(definitions, `${name}.md`),
      `---\nname: ${name}\ndescription: Automation test\nmodel: faux/faux-1\ntools: []\n${name === 'ultimate' ? 'resident: true\n' : ''}---\nKeep answers short.\n`,
    )
  const options = { ultimateRoot: resolve('.'), projectRoot: root, userHome, home, localSetup }
  const server = await fauxServer(options)
  tracked.server = server
  return {
    root,
    userHome,
    home,
    options,
    app: server,
    folder: (id: string) => join(userHome, '.ultimate/automations', basename(home), id),
  }
}
export async function create(app: Server) {
  const caller = await app.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  return (await app.extensions.invoke(
    'automations',
    'create',
    { name: 'Watch', ask: 'Watch this script' },
    new AbortController().signal,
    caller.id,
  )) as Automation
}
export async function writeRun(folder: string, script: string) {
  await mkdir(join(folder, 'state'), { recursive: true })
  await writeFile(join(folder, 'run'), `#!/bin/sh\n${script}\n`)
  await chmod(join(folder, 'run'), 0o700)
}
export function call(app: Server, action: string, id: string) {
  return app.extensions.invoke('automations', action, { id }, new AbortController().signal)
}
