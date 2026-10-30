import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { git } from '../../lib/git.ts'
import { read, tree } from '../../extensions/files/files.ts'
import { temp } from '../helpers.ts'

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
    expect(await read(root, 'normal.md')).toMatchObject({ kind: 'text', text: '# Hello' })
    expect(await read(root, 'untracked.md')).toMatchObject({ kind: 'text', text: 'untracked' })
    expect(await read(root, 'inside-link')).toMatchObject({ kind: 'text', text: 'inside' })
    await expect(read(root, 'ignored.txt')).rejects.toThrow('Not found in this scope')
    for (const path of ['.env.local', 'config/secrets.json'])
      await expect(read(root, path)).rejects.toThrow('Hidden: the name suggests secrets')
    await expect(read(root, 'outside-link')).rejects.toThrow('Outside the scope')
    // A listed link with an innocent name is judged by what it points at too.
    await expect(read(root, 'notes.txt')).rejects.toThrow('Hidden: the name suggests secrets')
    for (const path of ['readme.txt', 'settings.txt'])
      await expect(read(root, path)).rejects.toThrow('Not found in this scope')
  })

  it('omits secret names without hiding directories whose names merely mention secrets', async () => {
    expect(await tree(root)).not.toContain('config/secrets.json')
    expect(await tree(root)).toContain('extensions/secrets/README.md')
    expect(await read(root, 'extensions/secrets/README.md')).toMatchObject({ text: 'readable' })
  })
})
