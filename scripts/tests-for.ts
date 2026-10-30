import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = process.cwd()
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
const trackedSet = new Set(tracked)
const sourceFiles = tracked.filter(
  (file) =>
    /^(server|shared|lib|extensions|web|test|scripts|\.ultimate)\//.test(file) &&
    /\.tsx?$/.test(file),
)
const tests = sourceFiles.filter((file) => /^test\/.*\.test\.tsx?$/.test(file))
const resolveImport = (from: string, specifier: string) => {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(root, dirname(from), specifier)
  return [
    base,
    ...['.ts', '.tsx'].map((ext) => `${base}${ext}`),
    ...['index.ts', 'index.tsx'].map((name) => resolve(base, name)),
  ]
    .map((path) => {
      const relative = path.slice(root.length + 1)
      return trackedSet.has(relative) ? relative : undefined
    })
    .find(Boolean)
}
const graph = new Map<string, string[]>()
for (const file of sourceFiles) {
  const source = readFileSync(resolve(root, file), 'utf8')
  const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  )
  graph.set(
    file,
    imports
      .map((specifier) => resolveImport(file, specifier))
      .filter((value): value is string => !!value),
  )
}
const args = process.argv.slice(2)
const changed = args.length
  ? args
  : execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        execFileSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim(),
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
const covered = new Set<string>()
for (const changedFile of changed) {
  if (tests.includes(changedFile)) covered.add(changedFile)
  for (const test of tests) {
    const seen = new Set<string>()
    const visit = (file: string): boolean => {
      if (file === changedFile) return true
      if (seen.has(file)) return false
      seen.add(file)
      return (graph.get(file) ?? []).some(visit)
    }
    if (visit(test)) covered.add(test)
  }
  const match = changedFile.match(/^(?:\.ultimate\/)?extensions\/([^/]+)\//)
  if (match) {
    // Runtime-loaded extension matching uses extension names and extension paths in test sources (settings, fauxServer lists, and SSR paths).
    const name = match[1]
    const matchingTests = tests.filter((test) => {
      const source = readFileSync(resolve(root, test), 'utf8')
      return source.includes(name) || source.includes(`extensions/${name}/`)
    })
    for (const test of matchingTests.length ? matchingTests : tests) covered.add(test)
  }
}
const unit = [...covered].filter((file) => !file.startsWith('test/e2e/')).toSorted()
const e2e = [...covered].filter((file) => file.startsWith('test/e2e/')).toSorted()
const broad = changed.some(
  (file) =>
    /^(server|shared|lib)\//.test(file) ||
    file.startsWith('test/helpers') ||
    /^(package\.json|vite\.config\.ts|vitest.*\.config\.)/.test(file),
)
if (broad)
  console.log('Broad change: prefer the ci tool; static list follows (capped at 40 per group).')
console.log('Unit tests:')
for (const file of unit.slice(0, broad ? 40 : undefined)) console.log(file)
console.log(
  `pnpm vitest run${unit.length ? ` ${unit.slice(0, broad ? 40 : undefined).join(' ')}` : ''}`,
)
console.log('E2E tests:')
for (const file of e2e.slice(0, broad ? 40 : undefined)) console.log(file)
console.log(
  `pnpm vitest run --config test/e2e/vitest.config.ts${e2e.length ? ` ${e2e.slice(0, broad ? 40 : undefined).join(' ')}` : ''}`,
)
