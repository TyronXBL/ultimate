import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { useProjectSetup } from './project-setup.ts'
import { fileMemo } from '../lib/file-memo.ts'

export function extensionSettingsFiles(projectRoot: string, userHome = homedir()) {
  return [join(userHome, '.ultimate/settings.json'), join(projectRoot, '.ultimate/settings.json')]
}

const validLayers = new Map<string, Map<string, boolean>>()

/** Read with every extension discovery, several times per model request: kept while both files are unchanged (#222319). */
const kept = fileMemo<Awaited<ReturnType<typeof readExtensionSettings>>>()

export async function extensionSettings(projectRoot: string, userHome?: string) {
  const trusted = useProjectSetup(projectRoot, userHome)
  const key = [projectRoot, userHome, trusted].join('\0')
  const hit = kept.get(key)
  if (hit) return hit
  const since = Date.now()
  const settings = await readExtensionSettings(projectRoot, userHome, trusted)
  kept.set(key, settings, extensionSettingsFiles(projectRoot, userHome), since)
  return settings
}

async function readExtensionSettings(
  projectRoot: string,
  userHome: string | undefined,
  trusted: boolean,
) {
  const overrides = new Map<string, boolean>()
  const layers = new Map<string, 'user' | 'project'>()
  const contents: (string | null)[] = []
  const notices: string[] = []
  for (const [index, path] of extensionSettingsFiles(projectRoot, userHome).entries()) {
    if (index === 1 && !trusted) {
      contents.push(null)
      continue
    }
    let content: string | null = null
    try {
      content = await readFile(path, 'utf8')
      const settings = JSON.parse(content)
      if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new Error('Settings must be a JSON object')
      if (
        settings.extensions !== undefined &&
        (!settings.extensions ||
          typeof settings.extensions !== 'object' ||
          Array.isArray(settings.extensions))
      )
        throw new Error('extensions must be an object')
      const layer = new Map<string, boolean>()
      for (const [key, enabled] of [
        ['enable', true],
        ['disable', false],
      ] as const) {
        const names = settings.extensions?.[key]
        if (names === undefined) continue
        if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
          throw new Error(`extensions.${key} must be an array of names`)
        for (const name of names) layer.set(name, enabled)
      }
      validLayers.set(path, layer)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') validLayers.delete(path)
      else notices.push(`${path}: ${String(error)}`)
    }
    for (const [name, enabled] of validLayers.get(path) ?? []) {
      overrides.set(name, enabled)
      layers.set(name, index === 0 ? 'user' : 'project')
    }
    contents.push(content)
  }
  return { overrides, layers, contents, notices }
}
