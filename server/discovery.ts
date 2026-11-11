import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { discoveryRoots } from './project.ts'
import type { Source } from './project.ts'
import { useProjectSetup } from './project-setup.ts'
import { extensionSettings } from './extension-settings.ts'
import { coreTier, defaultOff } from '../shared/extension-api.ts'
import { fileMemo } from '../lib/file-memo.ts'

const sourceOrder = { builtin: 0, user: 1, project: 2 }

export function compareExtensions(
  a: { name: string; source: Source; order?: number },
  b: { name: string; source: Source; order?: number },
) {
  return (
    (a.order ?? 0) - (b.order ?? 0) ||
    sourceOrder[a.source] - sourceOrder[b.source] ||
    a.name.localeCompare(b.name)
  )
}

type Found = {
  name: string
  path: string
  /** `path` with symlinks resolved, read anew on each discovery: modules load from here, so a repointed link loads its new target. */
  target: string
  source: Source
  files: string[]
  core?: true
  error?: string
}

/**
 * The extension folders found per set of roots, kept while every folder listed and file read is unchanged: prompt
 * sections, agent discovery and the extension host scan several times per model request (#222319).
 */
const scans = fileMemo<Found[]>()

export async function discoverExtensions(
  ultimateRoot: string,
  projectRoot: string,
  userHome?: string,
  includeProject = false,
  settings?: Awaited<ReturnType<typeof extensionSettings>>,
) {
  const project = includeProject || useProjectSetup(projectRoot, userHome)
  const key = [ultimateRoot, projectRoot, userHome, project].join('\0')
  const found = scans.get(key) ?? (await scan(ultimateRoot, projectRoot, userHome, project, key))
  settings ??= await extensionSettings(projectRoot, userHome)
  const { overrides } = settings
  const entries = found
    .map((entry) => ({
      ...entry,
      // A core-tier extension stays on whatever the settings say; extension reloads report the ignored disable.
      enabled:
        entry.core ||
        (overrides.get(entry.name) ??
          !(entry.source === 'builtin' && defaultOff.includes(entry.name))),
    }))
    .toSorted(compareExtensions)
  return Object.assign(entries, { settings })
}

async function scan(
  ultimateRoot: string,
  projectRoot: string,
  userHome: string | undefined,
  project: boolean,
  key: string,
) {
  const since = Date.now()
  const paths: string[] = []
  const winners = new Map<string, Found>()
  const builtinCore = new Set<string>()
  for (const root of discoveryRoots(ultimateRoot, projectRoot, userHome)) {
    if (root.source === 'project' && !project) continue
    const directory = join(root.path, 'extensions')
    paths.push(directory)
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return []
      },
    )
    // A root's folders are read at once; roots stay in order, since a later one replaces an earlier one's names and
    // learns which of them are core.
    const found = await Promise.all(
      entries.map(async (entry): Promise<Found | undefined> => {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return undefined
        const path = join(directory, entry.name)
        // Links followed: a repointed link, a new file in the folder or an edited api.ts each change a stamp.
        paths.push(path, join(path, 'api.ts'))
        try {
          if (!(await stat(path)).isDirectory()) return undefined
          const files = await readdir(path)
          // Core belongs to a built-in's name: an outside folder keeps it only when it replaces a core built-in.
          const core =
            (root.source === 'builtin' || builtinCore.has(entry.name)) &&
            files.includes('api.ts') &&
            coreTier.test(await readFile(join(path, 'api.ts'), 'utf8'))
          // Learned before the folder's other reads, which may still fail; the built-in root asks no earlier name.
          if (core && root.source === 'builtin') builtinCore.add(entry.name)
          return {
            name: entry.name,
            path,
            target: await realpath(path),
            source: root.source,
            files,
            ...(core ? { core } : {}),
          }
        } catch (error) {
          return {
            name: entry.name,
            path,
            target: path,
            source: root.source,
            files: [],
            error: String(error),
          }
        }
      }),
    )
    for (const winner of found) if (winner) winners.set(winner.name, winner)
  }
  const result = [...winners.values()]
  scans.set(key, result, paths, since)
  return result
}
