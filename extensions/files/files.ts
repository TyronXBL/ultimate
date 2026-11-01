import { spawn } from 'node:child_process'
import { open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'

/**
 * Where a scope's files come from: the working tree at `root`, or with `rev` the tree Git committed at `rev` in the
 * repository at `repo`, read through Git alone; `root` is then where that tree's checkout was, for absolute paths.
 */
export type Source = { root: string; rev?: string; repo?: string }

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

// Room for about 250k paths; a bigger listing fails with git's error instead of buffering without bound.
const listingBuffer = 16 * 1024 * 1024

/**
 * The files committed at `rev` in `repo`, by path: mode, blob and size. Submodules and folders are not files, so they
 * are left out; symlinks are listed as the blob holding their target.
 */
async function committed(repo: string, rev: string) {
  const commit = await git(
    repo,
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${rev}^{commit}`,
  )
  const listing = await git(
    { cwd: repo, maxBuffer: listingBuffer },
    'ls-tree',
    '-r',
    '-l',
    '-z',
    '--full-tree',
    commit,
  )
  const files = new Map<string, { mode: string; oid: string; size: number }>()
  for (const record of listing.split('\0')) {
    // `<mode> <type> <oid> <size padded with spaces>\t<path>`
    const tab = record.indexOf('\t')
    const [mode, type, oid, size] = record.slice(0, tab).split(/ +/)
    if (type === 'blob') files.set(record.slice(tab + 1), { mode, oid, size: Number(size) })
  }
  return files
}

/** What Git lists in `source` (tracked, and untracked but not ignored; or committed at its `rev`), sorted, without secret-like names. */
export async function tree({ root, rev, repo = root }: Source) {
  const paths = rev
    ? [...(await committed(repo, rev)).keys()]
    : (
        await git(
          { cwd: root, maxBuffer: listingBuffer },
          'ls-files',
          '-co',
          '--exclude-standard',
          '-z',
        )
      ).split('\0')
  return [...new Set(paths.filter((path) => path && !hidden(path)))].toSorted()
}

/** Throws unless relative `path` has no secret-like name and Git lists it in `root`. */
async function allowed(root: string, path: string) {
  if (hidden(path)) throw new Error('Hidden: the name suggests secrets')
  const entries = await git(root, 'ls-files', '-co', '--exclude-standard', '-z', '--', path)
  if (!entries.split('\0').includes(path)) throw new Error('Not found in this scope')
}

function checkPath(path: string) {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..'))
    throw new Error('Outside the scope')
}

/**
 * The real path of relative `path` in `root` if the rule allows it; throws the reason otherwise. A symlink must pass
 * the rule twice: by its own name, and by the path it resolves to, so a listed link cannot reach `.env` or an ignored
 * file.
 */
async function listed(root: string, path: string) {
  checkPath(path)
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

/**
 * The blob committed at relative `path` of `rev` if the rule allows it; throws the reason otherwise. Like a symlink on
 * disk, a committed one must pass the rule by its own name and by what it resolves to: its target is walked one name
 * at a time, through committed links to files or folders, and every name on the way must stay inside the tree and
 * not suggest secrets.
 */
async function committedFile(repo: string, rev: string, path: string) {
  checkPath(path)
  if (hidden(path)) throw new Error('Hidden: the name suggests secrets')
  const files = await committed(repo, rev)
  if (!files.has(path)) throw new Error('Not found in this scope')
  const pending = path.split('/')
  const done: string[] = []
  // A chain longer than this is a loop, as the kernel's own limit treats it.
  let hops = 0
  while (pending.length) {
    const name = pending.shift()!
    if (name === '' || name === '.') continue
    if (name === '..') {
      if (!done.pop()) throw new Error('Outside the scope')
      continue
    }
    const current = [...done, name].join('/')
    if (hidden(current)) throw new Error('Hidden: the name suggests secrets')
    const file = files.get(current)
    if (file?.mode !== '120000') {
      done.push(name)
      continue
    }
    if (++hops > 40) throw new Error('Not found in this scope')
    // Not the trimming `git` helper: a link's target is its blob's bytes exactly.
    const { stdout: target } = await exec('git', ['cat-file', 'blob', file.oid], { cwd: repo })
    if (isAbsolute(target)) throw new Error('Outside the scope')
    // The target replaces the link's name, resolved from the folder holding the link.
    pending.unshift(...target.split('/'))
  }
  const file = files.get(done.join('/'))
  if (!file) throw new Error('Not found in this scope')
  return file
}

/** The first `length` bytes of blob `oid`, without loading the rest. */
function blobHead(repo: string, oid: string, length: number) {
  return new Promise<Buffer>((done, fail) => {
    const child = spawn('git', ['cat-file', 'blob', oid], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let total = 0
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= length) child.kill()
    })
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0 && total < length) fail(new Error(`git cat-file failed for ${oid}`))
      else done(Buffer.concat(chunks).subarray(0, length))
    })
  })
}

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

/** The file at relative `path` in `source`, if the rule in README.md allows it; throws a message the viewer shows. */
export async function read({ root, rev, repo = root }: Source, path: string) {
  let size: number
  let bytes: (length: number) => Promise<Buffer>
  if (rev) {
    const blob = await committedFile(repo, rev, path)
    size = blob.size
    bytes = (length) => blobHead(repo, blob.oid, length)
  } else {
    const file = await listed(root, path)
    size = (await stat(file)).size
    bytes = (length) => head(file, length)
  }
  const mime = imageTypes[extname(path).toLowerCase()]
  if (mime) {
    if (size > imageCap) throw new Error('Image exceeds 10 MB')
    return {
      path,
      size,
      kind: 'image' as const,
      mime,
      base64: (await bytes(size)).toString('base64'),
    }
  }
  // One byte past the cap tells whether the cut lands inside a character.
  const text = await bytes(textCap + 1)
  if (text.subarray(0, 8192).includes(0)) return { path, size, kind: 'binary' as const }
  if (text.length <= textCap)
    return { path, size, kind: 'text' as const, text: text.toString('utf8') }
  // Cut before the character the cap splits: back off over UTF-8 continuation bytes to its first byte.
  let end = textCap
  while (end > 0 && (text[end] & 0xc0) === 0x80) end--
  return {
    path,
    size,
    kind: 'text' as const,
    text: text.subarray(0, end).toString('utf8'),
    truncated: true,
  }
}

/** `path` (absolute, or relative to the source's root) as a readable path relative to that root, or null. */
export async function locate({ root, rev, repo = root }: Source, path: string) {
  const clean = path.replace(/^\.\//, '')
  try {
    if (rev) {
      // The checkout is gone, so an absolute path maps by where it was, as written.
      const rel = isAbsolute(clean) ? relative(root, clean).split(sep).join('/') : clean
      await committedFile(repo, rev, rel)
      return rel
    }
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
