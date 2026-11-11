import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@earendil-works/pi-durable'
import { fileMemo } from '../lib/file-memo.ts'

const errors = new Map<string, string>()
export function projectDiagnostics(projectRoot: string, userHome = homedir()) {
  projectDecision(projectRoot, userHome)
  const error = errors.get(join(userHome, '.ultimate/trust.json'))
  return error ? [error] : []
}

/** The project's settings file, read for families, the lander, workspaces and more: kept while unchanged (#222319). */
const settings = fileMemo<JsonObject>()

export async function projectSettings(
  projectRoot: string,
  userHome: string,
  report: (message: string) => void = () => {},
): Promise<JsonObject> {
  if (!useProjectSetup(projectRoot, userHome)) return {}
  const path = join(projectRoot, '.ultimate/settings.json')
  const hit = settings.get(path)
  // A copy each time: callers have always had an object of their own.
  if (hit) return structuredClone(hit)
  const since = Date.now()
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Project settings must be a JSON object')
    settings.set(path, structuredClone(value), [path], since)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') settings.set(path, {}, [path], since)
    else report(String(error))
    return {}
  }
}

/** Asked with every families read, kept while the folders and git files naming it are unchanged (#222319). */
const roots = fileMemo<string>()

/**
 * Where a folder's decision is kept: a linked git worktree shares its main checkout's, so a new worktree of a chosen
 * project needs no choice of its own.
 */
export function decisionRoot(projectRoot: string) {
  const hit = roots.get(projectRoot)
  if (hit) return hit
  const since = Date.now()
  const { root, paths } = decisionInputs(projectRoot)
  roots.set(projectRoot, root, paths, since)
  return root
}

/** `decisionRoot` and every path it read. */
function decisionInputs(projectRoot: string) {
  const root = realpathSync(resolve(projectRoot))
  // The folder's own stamp changes when a `.git` appears, goes or turns from a folder into a file. A `.git` folder
  // itself is not stamped: most git commands change it.
  const paths = [projectRoot]
  let link: string
  try {
    link = readFileSync(join(root, '.git'), 'utf8')
  } catch (error) {
    // No `.git` file: a main checkout (a `.git` directory) or a folder outside git keeps its own decision.
    if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code!))
      return { root, paths }
    throw error
  }
  paths.push(join(root, '.git'))
  const gitdir = resolve(root, link.match(/^gitdir: (.+)$/m)![1])
  paths.push(join(gitdir, 'commondir'))
  // A submodule's `.git` file has no `commondir`; it keeps its own decision too.
  if (!existsSync(join(gitdir, 'commondir'))) return { root, paths }
  const common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim())
  if (basename(common) !== '.git') return { root, paths }
  paths.push(dirname(common))
  return { root: realpathSync(dirname(common)), paths }
}

/**
 * Decisions by project folder and home, kept while the trust file and the folders that name the decision's root are
 * unchanged: definitions, settings and skills ask several times per model request, and each of Pi's reads takes its
 * lock (a directory made and removed) and reads the file (#222319).
 */
const decisions = fileMemo<boolean | null>()

export function projectDecision(projectRoot: string, userHome = homedir()) {
  const path = join(userHome, '.ultimate/trust.json')
  const key = `${projectRoot}\0${userHome}`
  const kept = decisions.get(key)
  if (kept !== undefined) {
    errors.delete(path)
    return kept
  }
  const since = Date.now()
  try {
    const { root, paths } = decisionInputs(projectRoot)
    const entry = new ProjectTrustStore(join(userHome, '.ultimate')).getEntry(root)
    errors.delete(path)
    const decision = entry?.path === root ? entry.decision : null
    decisions.set(key, decision, [path, ...paths], since)
    return decision
  } catch (error) {
    errors.set(path, String(error))
    return null
  }
}

export function useProjectSetup(projectRoot: string, userHome?: string) {
  return projectDecision(projectRoot, userHome) === true
}

export async function projectSetup(projectRoot: string, userHome?: string) {
  const root = join(projectRoot, '.ultimate')
  const config = ['extensions', 'agents', 'skills', 'settings.json'].some((name) =>
    existsSync(join(root, name)),
  )
  const readme = await readFile(join(root, 'README.md'), 'utf8').then(
    (text) =>
      Array.from(text)
        .slice(0, 16 * 1024)
        .join(''),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    },
  )
  return { config, decision: projectDecision(projectRoot, userHome), ...(readme ? { readme } : {}) }
}
