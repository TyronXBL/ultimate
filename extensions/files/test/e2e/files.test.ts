import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { git } from '../../../../lib/git.ts'
import { locate, read, tree } from '../../files.ts'
import { temp } from '../../../../test/helpers.ts'

let root: string
beforeAll(async () => {
  root = await temp('ultimate-files-')
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test')
  await mkdir(join(root, 'config'))
  await mkdir(join(root, 'inside'))
  await mkdir(join(root, 'extensions/secrets'), { recursive: true })
  await writeFile(join(root, 'normal.md'), '# Hello')
  await writeFile(join(root, 'config/secrets.json'), '{}')
  await writeFile(join(root, '.env.local'), 'hidden')
  await writeFile(join(root, 'extensions/secrets/README.md'), 'readable')
  await writeFile(join(root, 'inside/file.txt'), 'inside')
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-q', '-m', 'fixture')
  // A branch whose worktree is gone: its commit holds a secret-named file and links, read through Git alone.
  await git(root, 'switch', '-q', '-c', 'ultimate/gone')
  await writeFile(join(root, 'branch.md'), '# Branch')
  await writeFile(join(root, '.env'), 'committed secret')
  await git(root, 'add', '-f', '.env', 'branch.md')
  await symlink('/etc/passwd', join(root, 'escape.txt'))
  await symlink('../../outside', join(root, 'inside/up.txt'))
  await symlink('.env', join(root, 'env.txt'))
  await symlink('../branch.md', join(root, 'inside/branch-link.md'))
  await symlink('inside', join(root, 'alias'))
  await symlink('alias/file.txt', join(root, 'via-alias.txt'))
  await git(
    root,
    'add',
    'escape.txt',
    'inside/up.txt',
    'env.txt',
    'inside/branch-link.md',
    'alias',
    'via-alias.txt',
  )
  await git(root, 'commit', '-q', '-m', 'branch')
  await git(root, 'switch', '-q', 'main')
  await writeFile(join(root, 'ignored.txt'), 'ignored')
  await writeFile(join(root, 'untracked.md'), 'untracked')
  await symlink('inside/file.txt', join(root, 'inside-link'))
  await symlink('/etc/passwd', join(root, 'outside-link'))
  await symlink('.env.local', join(root, 'notes.txt'))
  await symlink('ignored.txt', join(root, 'readme.txt'))
  await symlink('.git/config', join(root, 'settings.txt'))
})

describe('file access rules', () => {
  it('reads listed files and in-root symlinks, refusing ignored, secret-like and escaping paths', async () => {
    const checkout = { root }
    expect(await read(checkout, 'normal.md')).toMatchObject({ kind: 'text', text: '# Hello' })
    expect(await read(checkout, 'untracked.md')).toMatchObject({ kind: 'text', text: 'untracked' })
    expect(await read(checkout, 'inside-link')).toMatchObject({ kind: 'text', text: 'inside' })
    await expect(read(checkout, 'ignored.txt')).rejects.toThrow('Not found in this scope')
    for (const path of ['.env.local', 'config/secrets.json'])
      await expect(read(checkout, path)).rejects.toThrow('Hidden: the name suggests secrets')
    await expect(read(checkout, 'outside-link')).rejects.toThrow('Outside the scope')
    // A listed link with an innocent name is judged by what it points at too.
    await expect(read(checkout, 'notes.txt')).rejects.toThrow('Hidden: the name suggests secrets')
    for (const path of ['readme.txt', 'settings.txt'])
      await expect(read(checkout, path)).rejects.toThrow('Not found in this scope')
  })

  it('reads a branch at its last commit by the same rule, without its checkout', async () => {
    const gone = {
      root: join(root, 'released-worktree'),
      repo: root,
      rev: 'refs/heads/ultimate/gone',
    }
    const files = await tree(gone)
    expect(files).toContain('branch.md')
    expect(files).not.toContain('.env')
    expect(files).not.toContain('untracked.md')
    expect(await read(gone, 'branch.md')).toMatchObject({ kind: 'text', text: '# Branch' })
    expect(await read(gone, 'inside/branch-link.md')).toMatchObject({ text: '# Branch' })
    // A link through a committed folder link, as a link on disk resolves.
    expect(await read(gone, 'via-alias.txt')).toMatchObject({ text: 'inside' })
    await expect(read(gone, '.env')).rejects.toThrow('Hidden: the name suggests secrets')
    await expect(read(gone, 'env.txt')).rejects.toThrow('Hidden: the name suggests secrets')
    for (const path of ['escape.txt', 'inside/up.txt'])
      await expect(read(gone, path)).rejects.toThrow('Outside the scope')
    await expect(read(gone, 'untracked.md')).rejects.toThrow('Not found in this scope')
    expect(await locate(gone, join(gone.root, 'branch.md'))).toBe('branch.md')
  })

  it('omits secret names without hiding directories whose names merely mention secrets', async () => {
    expect(await tree({ root })).not.toContain('config/secrets.json')
    expect(await tree({ root })).toContain('extensions/secrets/README.md')
    expect(await read({ root }, 'extensions/secrets/README.md')).toMatchObject({
      text: 'readable',
    })
  })
})
