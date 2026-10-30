/**
 * The test files covering changed files, and the commands that run just them:
 * `node scripts/tests-for.ts [files…]`, by default what this branch changed against main, committed or not.
 *
 * A test covers a file it imports, directly or through other files. Extensions are also loaded at runtime, which no
 * import shows, so a test that names an extension (its `extensions/<name>/` path, or `'<name>'` in quotes, as in a
 * `trimmedSourceCopy` list or a tool name) covers that extension's files too. A change every test depends on (server
 * core, test helpers, configuration) or one covered by many tests is reported as broad: run the `ci` tool instead.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)

const files = git('ls-files', '--cached', '--others', '--exclude-standard').filter(
  (file) =>
    /^(server|shared|lib|extensions|web|test|scripts|\.ultimate)\//.test(file) &&
    /\.tsx?$/.test(file) &&
    existsSync(file),
)
const known = new Set(files)
const tests = files.filter((file) => /^test\/.*\.test\.tsx?$/.test(file))
const source = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]))

/** Who imports each file: the reverse of every relative `from '…'`, `import('…')` and `import '…'`. */
const importers = new Map<string, string[]>()
for (const [file, text] of source)
  for (const [, specifier] of text.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"](\.[^'"]+)['"]/g)) {
    const base = normalize(join(dirname(file), specifier))
    const target = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((path) =>
      known.has(path),
    )
    if (target) importers.set(target, [...(importers.get(target) ?? []), file])
  }

/**
 * The test helpers import nearly everything a fauxServer needs, so every test would cover every file through them: a
 * change reaching a helper is followed no further, and the extension-name match below finds the tests that use it.
 */
const hub = (file: string) => file.startsWith('test/helpers')

const changed = process.argv.length > 2 ? process.argv.slice(2) : branchChanges()
const covering = new Set<string>()
for (const file of changed) {
  const seen = new Set([file])
  for (const current of seen)
    if (current === file || !hub(current))
      for (const importer of importers.get(current) ?? []) seen.add(importer)
  for (const test of tests) if (seen.has(test)) covering.add(test)
  const extension = /^(?:\.ultimate\/)?extensions\/([^/]+)\//.exec(file)?.[1]
  if (extension) {
    const named = new RegExp(`extensions/${extension}/|['"\`]${extension}['"\`]`)
    for (const test of tests) if (named.test(source.get(test)!)) covering.add(test)
  }
}

const unit = [...covering].filter((file) => !file.startsWith('test/e2e/')).toSorted()
const e2e = [...covering].filter((file) => file.startsWith('test/e2e/')).toSorted()
const core = changed.filter((file) =>
  /^(server\/|shared\/|test\/helpers|test\/e2e\/vitest\.config|package\.json|pnpm-lock|vite\.config|tsconfig)/.test(
    file,
  ),
)
if (core.length || covering.size > 30)
  console.log(
    `Broad change (${core.length ? core.join(', ') : `${covering.size} test files`}): run the ci tool rather than these locally.\n`,
  )
print('Unit', unit, 'pnpm vitest run')
print('E2E', e2e, 'pnpm vitest run --config test/e2e/vitest.config.ts')

function print(kind: string, list: string[], command: string) {
  console.log(`${kind} (${list.length}):`)
  // An empty list prints no command: `pnpm vitest run` without files would run the whole suite.
  console.log(list.length ? `${list.join('\n')}\n${command} ${list.join(' ')}\n` : 'none\n')
}

/** What this branch changed against main: committed, staged, unstaged and untracked. */
function branchChanges() {
  const base = git('merge-base', 'HEAD', 'main')[0]
  return [
    ...new Set([
      ...git('diff', '--name-only', base),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ]
}
