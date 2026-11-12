/**
 * A quicker `pnpm check` for iterating: `pnpm check:changed [files…]`, by default what this branch changed against
 * main, committed or not. It formats-checks, lints and type-checks the changed files and the files that import them
 * directly, then runs the whole-project checks that are cheap (`deps`, `pi-upstream`, `knip` with its cache), and
 * reports every failing step at once.
 *
 * It misses a type error two or more imports away from a change, and knip's cache can go stale, so the full
 * `pnpm check` still runs once before each commit, and the lander runs it on the merged result. A change to
 * configuration or packages, or one that reaches more than `limit` files, runs the full check instead.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { branchChanges, importers } from './changes.ts'

/**
 * Above about this many files the program the type check builds nears the whole project's: measured on this repository
 * (#261292), 50 files took 8.9 s and 1.5 GB, 638 files 27 s and 2.7 GB, the full check 32–42 s and 2.5 GB.
 */
const limit = 100
const bin = (name: string) => join(import.meta.dirname, '../node_modules/.bin', name)
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { stdio: 'inherit' }).status === 0

const changed = (process.argv.length > 2 ? process.argv.slice(2) : branchChanges()).filter((file) =>
  existsSync(file),
)
/** Changes that alter how every file is checked: lint rules, compiler and tool configuration, packages. */
const global = changed.filter(
  (file) =>
    /(^|\/)[^/]*config[^/]*$/.test(file) ||
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|lint\/|patches\/)/.test(file),
)
const checked = new Set(changed)
for (const file of changed) for (const importer of importers.get(file) ?? []) checked.add(importer)

if (global.length || checked.size > limit) {
  console.log(
    `Broad change (${global.length ? global.join(', ') : `${checked.size} files`}): running the full pnpm check.\n`,
  )
  process.exit(run('pnpm', ['check']) ? 0 : 1)
}
if (!checked.size) {
  console.log('Nothing changed against main.')
  process.exit(0)
}

console.log(`Checking ${changed.length} changed files and their importers, ${checked.size} in all.`)
const failed = [
  ['vp check', run(bin('vp'), ['check', '--no-error-on-unmatched-pattern', ...checked])],
  ['deps', run('node', [join(import.meta.dirname, 'deps.ts')])],
  ['pi-upstream', run('node', [join(import.meta.dirname, 'pi-upstream.ts')])],
  ['knip', run(bin('knip'), ['--no-progress', '--no-config-hints', '--cache'])],
].flatMap(([name, passed]) => (passed ? [] : [name]))
console.log(failed.length ? `\nFailed: ${failed.join(', ')}.` : '\nQuick check passed.')
process.exit(failed.length ? 1 : 0)
