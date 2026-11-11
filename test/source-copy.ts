// Copying the checkout for a test server, without Vitest's test-file globals, so the e2e global setup can use it too.
import { cp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function linkDependencies(root: string) {
  const target = join(root, 'node_modules')
  await mkdir(target)
  for (const name of await readdir(resolve('node_modules'))) {
    if (name.startsWith('.vite')) continue
    await symlink(resolve('node_modules', name), join(target, name))
  }
}

/** Copy the checkout into the empty folder `root`, without `.git`, its packages linked, to boot a server from. */
export async function copySource(root: string) {
  await mkdir(root, { recursive: true })
  // One cp per top-level entry: a `filter` makes Node walk the tree in JS, more than ten times slower.
  await Promise.all(
    (await readdir(resolve('.')))
      .filter((name) => name !== '.git' && name !== 'node_modules')
      .map((name) => cp(resolve(name), join(root, name), { recursive: true })),
  )
  await linkDependencies(root)
  const config = join(root, 'vite.config.ts')
  // This config is immutable after boot: ignore stale native events replayed from the initial copy.
  // Optimize on page requests, not fixture boot; React's plugin otherwise eagerly includes deps.
  const source = (await readFile(config, 'utf8'))
    .replace(
      'export default defineConfig({',
      "export default defineConfig({ server: { watch: { ignored: [(file) => file === fileURLToPath(import.meta.url)] } }, cacheDir: '.vite-cache', optimizeDeps: { entries: [] },",
    )
    .replace(
      'plugins: [react(), tailwindcss()],',
      "plugins: [react(), tailwindcss(), { name: 'test:lazy-deps', configResolved(config) { config.optimizeDeps.include = [] } }],",
    )
  await writeFile(config, source)
}
