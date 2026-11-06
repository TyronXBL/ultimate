import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { loadSkills, stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Skill } from '@earendil-works/pi-coding-agent'

type SkillScope = 'clone' | 'user' | 'project'

/** A loaded skill with where it came from, and the paths of same-named skills it overrides in earlier scopes. */
type ScopedSkill = Skill & { scope: SkillScope; overrides: string[] }

const ignoreFiles = ['.gitignore', '.ignore', '.fdignore']

/**
 * The paths, real paths (Pi drops a second link to one file) and texts of every file Pi's skill walk
 * (`loadSkillsFromDirInternal`) can read under `dir`: SKILL.md files, the layer's own `.md` files and ignore files.
 * Ignore rules are not applied, so this reads a superset; Pi stops at a folder's SKILL.md, and so does this unless an
 * ignore file on the way could hide that SKILL.md. Each real folder is read once, so a link back to an ancestor ends.
 */
function skillInputs(
  dir: string,
  top: boolean,
  ignoring: boolean,
  out: string[],
  seen = new Set<string>(),
) {
  const read = (path: string) => {
    try {
      return `${realpathSync.native(path)}\0${readFileSync(path, 'utf8')}`
    } catch (error) {
      return String(error)
    }
  }
  let entries: Dirent[]
  try {
    const real = realpathSync.native(dir)
    if (seen.has(real)) return
    seen.add(real)
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    out.push(dir, String(error))
    return
  }
  const kinds = entries.map((entry) => {
    const path = join(dir, entry.name)
    if (!entry.isSymbolicLink())
      return { entry, path, file: entry.isFile(), folder: entry.isDirectory() }
    try {
      const stats = statSync(path)
      return { entry, path, file: stats.isFile(), folder: stats.isDirectory() }
    } catch {
      // A broken link, which Pi skips too; once it resolves, what it points at is read here.
      return { entry, path, file: false, folder: false }
    }
  })
  for (const { entry, path } of kinds)
    if (ignoreFiles.includes(entry.name)) {
      ignoring = true
      out.push(path, read(path))
    }
  const skill = kinds.find(({ entry, file }) => entry.name === 'SKILL.md' && file)
  if (skill) {
    out.push(skill.path, read(skill.path))
    if (!ignoring) return
  }
  for (const { entry, path, file, folder } of kinds) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (folder) skillInputs(path, false, ignoring, out, seen)
    else if (top && file && entry.name.endsWith('.md')) out.push(path, read(path))
  }
}

/**
 * The last load per working directory, reused while the trust decision and every file the walk reads are the same: the
 * skills section renders before each model request, and parsing every skill was most of its time (#166097). Keyed by
 * content, not modification times or folder watches, so an edit shows on the next call however fast it follows. It
 * keeps a digest of the inputs and the most recent directories only: every worktree is a directory of its own.
 */
const loads = new Map<string, { inputs: string; result: ReturnType<typeof loadLayers> }>()
const LOADS_KEPT = 32

/**
 * Skills from the clone, `~/.ultimate/skills` and, once the project is trusted, its `.pi/skills` (before the user's),
 * `.agents/skills` and `.ultimate/skills`. A later scope overrides an earlier skill of the same name (Pi keeps the first;
 * Ultimate lets the project override the user and the user the clone). Diagnostics are Pi's, per file.
 */
export function projectSkills(
  host: { ultimateRoot: string; projectRoot: string; userHome: string },
  cwd = host.projectRoot,
) {
  // Every project folder waits for trust: an untrusted checkout must not put its skills in the prompt or shadow a
  // built-in one (#162411). A project's `.agents/skills` (the Agent Skills folder other tools share) loads with its
  // `.ultimate/skills`. The personal `~/.agents/skills` does not: personal skills for Ultimate live in
  // `~/.ultimate/skills`.
  const trusted = useProjectSetup(host.projectRoot, host.userHome)
  const layers: [string, SkillScope][] = [
    [join(host.ultimateRoot, 'skills'), 'clone'],
    ...(trusted ? ([[join(cwd, '.pi/skills'), 'project']] as [string, SkillScope][]) : []),
    [join(host.userHome, '.ultimate/skills'), 'user'],
    ...(trusted
      ? ([
          [join(host.projectRoot, '.agents/skills'), 'project'],
          [join(host.projectRoot, '.ultimate/skills'), 'project'],
        ] as [string, SkillScope][])
      : []),
  ]
  // Most folders don't exist; Pi warns about each missing one, which says nothing here.
  const present = layers.filter(([folder]) => existsSync(folder))
  const out: string[] = []
  for (const [folder] of present) skillInputs(folder, true, false, out)
  const inputs = createHash('sha256')
    .update(JSON.stringify([present, out]))
    .digest('base64')
  const key = [host.ultimateRoot, host.projectRoot, host.userHome, cwd].join('\0')
  const last = loads.get(key)
  // Deleted and set again, so the map's order is least recently used first.
  loads.delete(key)
  const result =
    last?.inputs === inputs
      ? last.result
      : loadLayers(present, cwd, join(host.userHome, '.ultimate'))
  loads.set(key, { inputs, result })
  if (loads.size > LOADS_KEPT) loads.delete(loads.keys().next().value!)
  return result
}

/** Pi's skills of each layer, a later scope overriding an earlier skill of the same name. */
function loadLayers(layers: [string, SkillScope][], cwd: string, agentDir: string) {
  const byName = new Map<string, ScopedSkill>()
  const diagnostics = []
  for (const [path, scope] of layers) {
    const loaded = loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false })
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills) {
      const earlier = byName.get(skill.name)
      // Map order is first insertion: delete so the winner lists where its own scope puts it.
      byName.delete(skill.name)
      byName.set(skill.name, {
        ...skill,
        scope,
        overrides: earlier ? [...earlier.overrides, earlier.filePath] : [],
      })
    }
  }
  return { skills: [...byName.values()], diagnostics }
}

/**
 * `/skill:name args` as Pi's AgentSession expands it: the skill's body in a `<skill>` block, then the arguments as the
 * request, with the skill named and whether it is known. Any other text, or an unknown skill, comes back as it was.
 */
export function expandSkillCommand(
  text: string,
  skills: readonly Skill[],
): { text: string; skill?: { name: string; known: boolean } } {
  // Pi upstream: @earendil-works/pi-coding-agent@1.5.0 src/core/agent-session.ts _expandSkillCommand — copied block format. Drop when Pi exports the expansion.
  const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return { text }
  const skill = skills.find((candidate) => candidate.name === match[1])
  if (!skill) return { text, skill: { name: match[1], known: false } }
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim()
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  const args = match[2]?.trim()
  return { text: args ? `${block}\n\n${args}` : block, skill: { name: skill.name, known: true } }
}
