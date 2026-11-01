import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ExtensionHost } from '../server/extensions.ts'

/**
 * The skills an agent working in `cwd` is shown. A skill inside the host project is listed at the work checkout's copy
 * when it has one (a worktree): that is the copy the agent reads and edits; the host's copy can be older or newer and
 * is not its to change.
 */
export function listedSkills(host: Pick<ExtensionHost, 'projectRoot' | 'skills'>, cwd: string) {
  return host.skills(cwd).map((skill) => {
    const inProject = relative(host.projectRoot, skill.filePath)
    const copy = join(cwd, inProject)
    return cwd !== host.projectRoot && !inProject.startsWith('..') && existsSync(copy)
      ? { ...skill, filePath: copy }
      : skill
  })
}
