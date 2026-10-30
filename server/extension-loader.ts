// Loads extension server facets with Node's own import(). Vitest loads this file natively (`test.server.deps.external`
// in vite.config.ts), so tests take the same path; keep it free of imports from other core files.
import { existsSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'rolldown/utils'

type Graph = {
  id: string
  /** Ultimate's package.json, where bare imports resolve first. */
  packages: string
  versions: Map<string, number>
  importers: Map<string, Set<string>>
  imports: Map<string, Set<string>>
}
/** Each loader's graph by id: a module joins it through `?ultimate=<id>.<version>`, so servers never share modules. */
const graphs = new Map<string, Graph>()
let ids = 0
let kept = 0
let registered = false

const graphOf = (url: string | undefined) => {
  if (!url?.startsWith('file:')) return undefined
  const tag = new URL(url).searchParams.get('ultimate')
  return tag ? graphs.get(tag.slice(0, tag.indexOf('.'))) : undefined
}
const link = (edges: Map<string, Set<string>>, from: string, to: string) => {
  const set = edges.get(from) ?? new Set()
  set.add(to)
  edges.set(from, set)
}
const bare = (specifier: string) => !/^(\.|\/|#|[a-z][a-z0-9+.-]*:)/i.test(specifier)

function register() {
  if (registered) return
  registered = true
  registerHooks({
    resolve(specifier, context, next) {
      const graph = graphOf(context.parentURL)
      if (!graph) return next(specifier, context)
      let result
      if (bare(specifier)) {
        // Ultimate's packages first, as Vite deduped them, so an extension outside the clone shares its pi-durable.
        try {
          result = next(specifier, { ...context, parentURL: graph.packages })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error
          result = next(specifier, context)
        }
      } else result = next(specifier, context)
      if (!result.url.startsWith('file:') || result.url.includes('/node_modules/')) return result
      const file = fileURLToPath(result.url)
      const parent = fileURLToPath(context.parentURL!)
      link(graph.importers, file, parent)
      link(graph.imports, parent, file)
      return { ...result, url: tagged(file, graph), shortCircuit: true }
    },
    load(url, context, next) {
      if (graphOf(url)) kept++
      // Node strips no types under node_modules; a package that ships TypeScript (pi-claude-code) is transformed here.
      if (
        url.startsWith('file:') &&
        url.includes('/node_modules/') &&
        /\.[cm]?ts$/.test(new URL(url).pathname)
      ) {
        const { source } = next(url, context)
        const text = typeof source === 'string' ? source : new TextDecoder().decode(source)
        const result = transformSync(fileURLToPath(url), text)
        if (result.errors.length) throw result.errors[0]
        return { format: 'module', source: result.code, shortCircuit: true }
      }
      return next(url, context)
    },
  })
}
function tagged(file: string, graph: Graph) {
  const url = pathToFileURL(file)
  url.search = `?ultimate=${graph.id}.${graph.versions.get(file) ?? 0}`
  return url.href
}

/** Extension modules this process has evaluated; Node never frees a module, so each reload keeps its old copies. */
export const keptModules = () => kept

export function extensionLoader(ultimateRoot: string) {
  register()
  const id = String(++ids)
  const graph: Graph = {
    id,
    packages: pathToFileURL(join(ultimateRoot, 'package.json')).href,
    versions: new Map(),
    importers: new Map(),
    imports: new Map(),
  }
  graphs.set(id, graph)
  /** Give `file` and everything reached through `edges` a new version, so each loads anew; returns them. */
  const renew = (file: string, edges: Map<string, Set<string>>) => {
    const visited = new Set<string>()
    const visit = (current: string) => {
      if (visited.has(current)) return
      visited.add(current)
      graph.versions.set(current, (graph.versions.get(current) ?? 0) + 1)
      for (const next of edges.get(current) ?? []) visit(next)
    }
    visit(file)
    return visited
  }
  return {
    /** The module of `file`: the same instance until `file` or a module it imports is invalidated. */
    // oxlint-disable-next-line typescript/no-explicit-any -- an extension module's exports are validated by the caller.
    async load(file: string): Promise<Record<string, any>> {
      try {
        return await import(tagged(file, graph))
      } catch (error) {
        // Node keeps a failed module at its URL; the next load gets new URLs for the entry and all it imported.
        renew(file, graph.imports)
        throw error
      }
    },
    /** `file` changed: it and every module importing it load anew; returns those files. */
    invalidate(file: string) {
      // The graph keys resolved files; a removed file resolves through its folder.
      const folder = dirname(file)
      const resolved = existsSync(file)
        ? realpathSync(file)
        : existsSync(folder)
          ? join(realpathSync(folder), basename(file))
          : file
      return renew(resolved, graph.importers)
    },
    close() {
      graphs.delete(id)
    },
  }
}
