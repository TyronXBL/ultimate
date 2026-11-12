/**
 * The test files covering changed files, and the commands that run just them:
 * `node scripts/tests-for.ts [files…]`, by default what this branch changed against main, committed or not.
 *
 * A test covers a file it imports, directly or through other files. Extensions are also loaded at runtime, which no
 * import shows, so an extension's own tests (`extensions/<name>/test/`) and a test that names it (its
 * `extensions/<name>/` path, or `'<name>'` in quotes, as in a `trimmedSourceCopy` list or a tool name) cover that
 * extension's files too. A change every test depends on (server
 * core, test helpers, configuration) or one covered by many tests is reported as broad: run the `ci` tool instead.
 */
import { branchChanges, files, importers, source } from './changes.ts'

/** Core and integration tests in `test/`, each extension's own in `extensions/<name>/test/`. */
const inTests = (file: string) => /^(test|extensions\/[^/]+\/test)\//.test(file)
const isE2e = (file: string) => /^(test|extensions\/[^/]+\/test)\/e2e\//.test(file)
const tests = files.filter((file) => inTests(file) && /\.test\.tsx?$/.test(file))

/**
 * The test helpers import nearly everything a fauxServer needs, so every test would cover every file through them: a
 * change reaching a helper is followed no further, and the extension-name match below finds the tests that use it.
 */
const hub = (file: string) => file.startsWith('test/helpers')

/** The tests that import `file`, directly or through other files, `file` itself included when it is one. */
function importingTests(file: string) {
  const seen = new Set([file])
  for (const current of seen)
    if (current === file || !hub(current))
      for (const importer of importers.get(current) ?? []) seen.add(importer)
  return tests.filter((test) => seen.has(test))
}

const changed = process.argv.length > 2 ? process.argv.slice(2) : branchChanges()
const covering = new Set<string>()
for (const file of changed) {
  for (const test of importingTests(file)) covering.add(test)
  const extension = /^(?:\.ultimate\/)?extensions\/([^/]+)\//.exec(file)?.[1]
  if (!extension) continue
  // The extension's own tests, and a test or a shared fixture (a test-folder file tests import) that names it, load it.
  const named = new RegExp(`extensions/${extension}/|['"\`]${extension}['"\`]`)
  for (const [path, text] of source)
    if (
      inTests(path) &&
      !hub(path) &&
      (path.startsWith(`extensions/${extension}/test/`) || named.test(text))
    )
      for (const test of importingTests(path)) covering.add(test)
}

const unit = [...covering].filter((file) => !isE2e(file)).toSorted()
const e2e = [...covering].filter(isE2e).toSorted()
/** Changes the graph cannot place: core, helpers, configuration and anything else outside the mapped folders. */
const core = changed.filter(
  (file) =>
    !file.endsWith('.md') &&
    (hub(file) ||
      /(^|\/)[^/]*config[^/]*$/.test(file) ||
      !/^(extensions|\.ultimate|web|lib|scripts|test)\//.test(file)),
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
