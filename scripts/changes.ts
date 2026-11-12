/**
 * What this branch changed, and who imports each source file: shared by `tests-for.ts` (the tests covering a change)
 * and `check-changed.ts` (the files a quick check reads).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)

/** The TypeScript files of the mapped folders, tracked or untracked. */
export const files = git('ls-files', '--cached', '--others', '--exclude-standard').filter(
  (file) =>
    /^(server|shared|lib|extensions|web|test|scripts|\.ultimate)\//.test(file) &&
    /\.tsx?$/.test(file) &&
    existsSync(file),
)
const known = new Set(files)
export const source = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]))

/** Who imports each file: the reverse of every relative `from '…'`, `import('…')` and `import '…'`. */
export const importers = new Map<string, string[]>()
for (const [file, text] of source)
  for (const [, specifier] of text.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"](\.[^'"]+)['"]/g)) {
    const base = normalize(join(dirname(file), specifier))
    const target = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((path) =>
      known.has(path),
    )
    if (target) importers.set(target, [...(importers.get(target) ?? []), file])
  }

/** What this branch changed against main: committed, staged, unstaged and untracked, deleted files included. */
export function branchChanges() {
  const base = git('merge-base', 'HEAD', 'main')[0]
  return [
    ...new Set([
      ...git('diff', '--name-only', base),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ]
}
