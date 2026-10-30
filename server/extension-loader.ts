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
  /** A local file the graph reaches for the first time, including one an import names that does not exist yet. */
  found: (file: string) => void
}
/** Each loader's graph by id: a module joins it through `?ultimate=<id>.<version>`, so servers never share modules. */
const graphs = new Map<string, Graph>()
/** URLs of graph modules whose body ran to the end; Node keeps each one for good. */
const evaluated = new Set<string>()
const EVALUATED = Symbol.for('ultimate.extension-loader.evaluated')
let ids = 0
let registered = false

const graphOf = (url: string | undefined) => {
  if (!url?.startsWith('file:')) return undefined
  const tag = new URL(url).searchParams.get('ultimate')
  return tag ? graphs.get(tag.slice(0, tag.indexOf('.'))) : undefined
}
const bare = (specifier: string) => !/^(\.|\/|#|[a-z][a-z0-9+.-]*:)/i.test(specifier)
const tagged = (file: string, graph: Graph) => {
  const url = pathToFileURL(file)
  url.search = `?ultimate=${graph.id}.${graph.versions.get(file) ?? 0}`
  return url.href
}
/** A file still imported, or importing: one whose importers all reloaded without it no longer counts. */
const known = (graph: Graph, file: string) =>
  !!graph.importers.get(file)?.size || graph.imports.has(file)
/** How the graph keys `file`: Node's resolved path, or for a missing file its nearest existing folder's. */
function real(file: string): string {
  if (existsSync(file)) return realpathSync(file)
  const folder = dirname(file)
  return folder === file ? file : join(real(folder), basename(file))
}
/** Record that `parent` imports `file`; returns whether the graph had not seen `file` before. */
function link(graph: Graph, parent: string, file: string) {
  const added = !known(graph, file)
  const importers = graph.importers.get(file) ?? new Set()
  importers.add(parent)
  graph.importers.set(file, importers)
  const imports = graph.imports.get(parent) ?? new Set()
  imports.add(file)
  graph.imports.set(parent, imports)
  return added
}

function register() {
  if (registered) return
  registered = true
  ;(globalThis as Record<symbol, unknown>)[EVALUATED] = (url: string) => evaluated.add(url)
  registerHooks({
    resolve(specifier, context, next) {
      const graph = graphOf(context.parentURL)
      if (!graph) return next(specifier, context)
      const parent = fileURLToPath(context.parentURL!)
      let result
      try {
        // Ultimate's packages first, as Vite deduped them, so an extension outside the clone shares its pi-durable.
        result = bare(specifier)
          ? next(specifier, { ...context, parentURL: graph.packages })
          : next(specifier, context)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ERR_MODULE_NOT_FOUND') throw error
        if (bare(specifier)) result = next(specifier, context)
        else {
          // The file may appear later: its importer then loads anew like on a change. The watcher drops a file once
          // it is removed, so it is handed over on every failure, not only when new.
          if (specifier.startsWith('.') || specifier.startsWith('/')) {
            const missing = real(fileURLToPath(new URL(specifier, context.parentURL)))
            link(graph, parent, missing)
            graph.found(missing)
          }
          throw error
        }
      }
      if (!result.url.startsWith('file:') || result.url.includes('/node_modules/')) return result
      const file = fileURLToPath(result.url)
      if (link(graph, parent, file)) graph.found(file)
      return { ...result, url: tagged(file, graph), shortCircuit: true }
    },
    load(url, context, next) {
      const typescriptPackage =
        url.includes('/node_modules/') && /\.[cm]?ts$/.test(new URL(url).pathname)
      if (!graphOf(url) && !typescriptPackage) return next(url, context)
      const result = next(url, context)
      if (result.format !== 'module' && result.format !== 'module-typescript') return result
      let source =
        typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source)
      // Node strips no types under node_modules; a package that ships TypeScript (pi-claude-code) is transformed here.
      if (typescriptPackage) {
        const transformed = transformSync(fileURLToPath(url), source)
        if (transformed.errors.length) throw transformed.errors[0]
        return { format: 'module', source: transformed.code, shortCircuit: true }
      }
      // Runs only once the module's body (and so everything it imports) finished without throwing.
      source += `\n;globalThis[Symbol.for('ultimate.extension-loader.evaluated')](import.meta.url)\n`
      return { format: result.format, source, shortCircuit: true }
    },
  })
}

/** Extension modules this process has evaluated; Node never frees a module, so each reload keeps its old copies. */
export const keptModules = () => evaluated.size

export function extensionLoader(ultimateRoot: string, found: (file: string) => void) {
  register()
  const id = String(++ids)
  const graph: Graph = {
    id,
    packages: pathToFileURL(join(ultimateRoot, 'package.json')).href,
    versions: new Map(),
    importers: new Map(),
    imports: new Map(),
    found,
  }
  graphs.set(id, graph)
  /** Load `files` anew under new versions; with `forget`, their imports are recorded again as they load. */
  const renew = (files: Set<string>, forget: boolean) => {
    for (const file of files) {
      graph.versions.set(file, (graph.versions.get(file) ?? 0) + 1)
      if (!forget) continue
      for (const child of graph.imports.get(file) ?? []) graph.importers.get(child)?.delete(file)
      graph.imports.delete(file)
    }
    return files
  }
  return {
    /** Local files the graph knows, for the watcher. */
    files: () => new Set([...graph.importers.keys(), ...graph.imports.keys()]),
    /** Whether an extension imports `file`, or tried to before it existed. */
    knows: (file: string) => known(graph, real(file)),
    /** The module of `file`: the same instance until `file` or a module it imports is invalidated. */
    // oxlint-disable-next-line typescript/no-explicit-any -- an extension module's exports are validated by the caller.
    async load(file: string): Promise<Record<string, any>> {
      try {
        return await import(tagged(file, graph))
      } catch (error) {
        // Node keeps a failed module at its URL. The modules that did not finish (the failing one and its importers
        // up to `file`) get new URLs; those that did stay, so a module shared with loaded extensions keeps its state.
        const failed = new Set<string>()
        const visit = (current: string) => {
          if (failed.has(current) || evaluated.has(tagged(current, graph))) return
          failed.add(current)
          for (const child of graph.imports.get(current) ?? []) visit(child)
        }
        visit(file)
        // Their edges stay: a missing import's edge is how its file appearing reloads them.
        renew(failed, false)
        throw error
      }
    },
    /** `file` changed, appeared or went away: it and every module importing it load anew; returns those files. */
    invalidate(file: string) {
      const resolved = real(file)
      const stale = new Set<string>()
      const visit = (current: string) => {
        if (stale.has(current)) return
        stale.add(current)
        for (const importer of graph.importers.get(current) ?? []) visit(importer)
      }
      visit(resolved)
      return renew(stale, true)
    },
    close() {
      graphs.delete(id)
    },
  }
}
