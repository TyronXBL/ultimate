import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { TestProject } from 'vitest/node'
import { createWeb } from '../../server/web.ts'
import { copySource } from '../source-copy.ts'
import { testTempPrefix } from '../sweep-temp.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's source copy and the `web/` folder of a home that built its bundle (`fauxServer({ web: true })`). */
    webBundle: { root: string; web: string }
  }
}

/**
 * Build the web bundle once for the whole run, as a server builds it on its first page load, so no browser test's
 * first `page.goto` waits for a build (19–27 s each on a busy 6-core machine). The bundle names its sources by absolute
 * path, so every `web` server runs from this one copy of the checkout, as the host's projects run from one clone.
 */
export default async function setup(project: TestProject) {
  // Named like a worker's temporary folder: an interrupted run leaves it to the next run's sweep (sweep-temp.ts).
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), `${testTempPrefix}${process.pid}-web-`)),
  )
  const root = join(parent, 'source')
  const userHome = join(parent, 'user')
  const home = join(parent, 'home')
  await copySource(root)
  new ProjectTrustStore(join(userHome, '.ultimate')).set(root, true)
  // The bundle lists the settings among its sources, and a missing one counts as changed: a server would build again.
  await mkdir(join(userHome, '.ultimate'), { recursive: true })
  await writeFile(join(userHome, '.ultimate/settings.json'), '{}\n')
  const notices: string[] = []
  const web = await createWeb({
    ultimateRoot: root,
    projectRoot: root,
    userHome,
    home,
    watch: () => () => {},
    before: async () => {},
    pages: () => 1,
    changed: () => {},
    notice: (message) => notices.push(message),
  })
  await web.rebuild()
  await web.close()
  if (notices.length) throw new Error(notices.join('\n'))
  project.provide('webBundle', { root, web: join(home, 'web') })
  return () => rm(parent, { recursive: true, force: true })
}
