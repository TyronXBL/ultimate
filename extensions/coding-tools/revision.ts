// Pi upstream: @earendil-works/pi-durable@1.4.0 src/tools/read.ts — the read tool loads a file's content only through env.openBinaryReader, which atRevision replaces. Drop when Pi's read tool accepts a reader or a revision.
import { stat } from 'node:fs/promises'
import { basename, dirname, relative } from 'node:path'
import type { Context } from '@earendil-works/chord'
import {
  type BinaryReader,
  type ExecutionEnv,
  getOrThrow,
  LineScanner,
  ok,
} from '@earendil-works/pi-durable/env'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'

/** The largest file `read` loads at a revision; Pi's read shows at most 50 KB of text, and images are far smaller. */
const MAX_BLOB = 64 * 1024 * 1024

/**
 * `env` with the file at `path` as committed in `rev`: Pi's read tool then opens these bytes instead of the working
 * tree's file, so line numbers, truncation and images work as for any file. `path` resolves like the read tool's own,
 * in the repository holding it; every worktree of one repository shares its commits.
 */
export async function atRevision(
  env: ExecutionEnv,
  path: string,
  rev: string,
  context: Context,
): Promise<ExecutionEnv> {
  const absolute = getOrThrow(await env.absolutePath(path, context))
  // The file, or even its folder, may be gone from the working tree; git runs in the nearest folder that remains.
  let cwd = dirname(absolute)
  while (!(await isDirectory(cwd))) cwd = dirname(cwd)
  await git(cwd, 'rev-parse', '--git-dir').catch((error: unknown) => {
    throw new Error(`${path} is not in a Git repository, so it has no revision ${rev}`, {
      cause: error,
    })
  })
  const commit = await git(
    cwd,
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${rev}^{commit}`,
  ).catch((error: unknown) => {
    throw new Error(`Unknown revision ${rev}: it names no commit in the repository of ${path}`, {
      cause: error,
    })
  })
  // `./` makes the path relative to cwd rather than to the repository's top.
  const object = `${commit}:./${relative(cwd, absolute)}`
  const type = await git(cwd, 'cat-file', '-t', object).catch((error: unknown) => {
    throw new Error(`${path} does not exist at ${rev}`, { cause: error })
  })
  if (type !== 'blob')
    throw new Error(`${path} is a ${type === 'tree' ? 'directory' : type} at ${rev}`)
  const { stdout } = await exec('git', ['cat-file', 'blob', object], {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_BLOB,
  })
  // A plain array, not a Node Buffer: the image processor transfers what `read` returns to its worker.
  const bytes = new Uint8Array(stdout)
  const reader: BinaryReader = {
    info: async () =>
      ok({
        name: basename(absolute),
        path: absolute,
        kind: 'file',
        size: bytes.length,
        mtimeMs: 0,
      }),
    // A copy, so a transfer detaches only it.
    read: async (offset, length) => ok(bytes.slice(offset, offset + length)),
    scanLines: async ({ startLine, endLine }) => {
      const scanner = new LineScanner(startLine, endLine)
      scanner.push(bytes)
      return ok(scanner.finish())
    },
    close: async () => {},
  }
  return new Proxy(env, {
    get(target, key) {
      if (key === 'openBinaryReader') return async () => ok(reader)
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function isDirectory(path: string) {
  return (
    await stat(path).catch(
      // A missing folder is what the caller walks up past.
      () => undefined,
    )
  )?.isDirectory()
}
