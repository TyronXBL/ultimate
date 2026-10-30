import { open, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { git } from '../../lib/git.ts'

const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}
/** Whether any part of `path` is named like a file that holds secrets. */
const hidden = (path: string) =>
  path
    .split('/')
    .some(
      (name) =>
        ['.ssh', '.netrc', '.npmrc', '.pgpass', '.htpasswd'].includes(name) ||
        /^\.env(?:rc)?(?:\.|$)/i.test(name) ||
        /^(?:secrets|auth)\.json$/i.test(name) ||
        /credentials/i.test(name) ||
        /\.pem$/i.test(name) ||
        /\.(?:key|p12|pfx)$/i.test(name) ||
        (/^id_/i.test(name) && !/\.pub$/i.test(name)),
    )

/** What Git lists in `root` (tracked, and untracked but not ignored), sorted, without secret-like names. */
export async function tree(root: string) {
  // Room for about 250k paths; a bigger listing fails with git's error instead of buffering without bound.
  const listing = await git(
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
  )
  return [...new Set(listing.split('\0').filter((path) => path && !hidden(path)))].toSorted()
}

/** Throws unless relative `path` has no secret-like name and Git lists it in `root`. */
async function allowed(root: string, path: string) {
  if (hidden(path)) throw new Error('Hidden: the name suggests secrets')
  const entries = await git(root, 'ls-files', '-co', '--exclude-standard', '-z', '--', path)
  if (!entries.split('\0').includes(path)) throw new Error('Not found in this scope')
}

/**
 * The real path of relative `path` in `root` if the rule allows it; throws the reason otherwise. A symlink must pass
 * the rule twice: by its own name, and by the path it resolves to, so a listed link cannot reach `.env` or an ignored
 * file.
 */
async function listed(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..'))
    throw new Error('Outside the scope')
  await allowed(root, path)
  const rootReal = await realpath(root)
  const fileReal = await realpath(resolve(root, path)).catch(() => {
    throw new Error('Not found in this scope')
  })
  const rel = relative(rootReal, fileReal)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Outside the scope')
  const target = rel.split(sep).join('/')
  if (target !== path) await allowed(root, target)
  return fileReal
}

const imageCap = 10 * 1024 * 1024
const textCap = 2 * 1024 * 1024

/** The first `length` bytes of `file`, without reading the rest. */
async function head(file: string, length: number) {
  const handle = await open(file)
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** The file at relative `path` in `root`, if the rule in README.md allows it; throws a message the viewer shows. */
export async function read(root: string, path: string) {
  const file = await listed(root, path)
  const { size } = await stat(file)
  const mime = imageTypes[extname(path).toLowerCase()]
  if (mime) {
    if (size > imageCap) throw new Error('Image exceeds 10 MB')
    return {
      path,
      size,
      kind: 'image' as const,
      mime,
      base64: (await readFile(file)).toString('base64'),
    }
  }
  // One byte past the cap tells whether the cut lands inside a character.
  const bytes = await head(file, textCap + 1)
  if (bytes.subarray(0, 8192).includes(0)) return { path, size, kind: 'binary' as const }
  if (bytes.length <= textCap)
    return { path, size, kind: 'text' as const, text: bytes.toString('utf8') }
  // Cut before the character the cap splits: back off over UTF-8 continuation bytes to its first byte.
  let end = textCap
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return {
    path,
    size,
    kind: 'text' as const,
    text: bytes.subarray(0, end).toString('utf8'),
    truncated: true,
  }
}

/** `path` (absolute, or relative to `root`) as a readable path relative to `root`, or null. */
export async function locate(root: string, path: string) {
  const clean = path.replace(/^\.\//, '')
  try {
    if (isAbsolute(clean)) {
      const real = await realpath(clean)
      const base = await realpath(root)
      const rel = relative(base, real)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
      await listed(root, rel.split(sep).join('/'))
      return rel.split(sep).join('/')
    }
    await listed(root, clean)
    return clean
  } catch {
    // Not readable in this scope, for whichever reason: the caller tries the next scope.
    return null
  }
}
