/** An Ultimate checkout's installed packages against its lockfile, and installing them. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from './exec.ts'

const read = (path: string) =>
  readFile(path, 'utf8').catch(
    // A missing lockfile or install reads as absent: no clone of Ultimate lacks both.
    () => undefined,
  )

/** The lockfile `root` asks for: versions and patch hashes of every package. */
export const wantedLockfile = (root: string) => read(join(root, 'pnpm-lock.yaml'))

/** The lockfile `root` asks for and the one pnpm last installed there (`node_modules/.pnpm/lock.yaml`). */
const lockfiles = async (root: string) => ({
  wanted: await wantedLockfile(root),
  installed: await read(join(root, 'node_modules/.pnpm/lock.yaml')),
})

/** Whether `pnpm-lock.yaml` differs from what pnpm last installed (`node_modules/.pnpm/lock.yaml`). */
export async function installOwed(root: string) {
  const { wanted, installed } = await lockfiles(root)
  return wanted !== undefined && wanted !== installed
}

/** Whether `root` has a `pnpm-lock.yaml` and pnpm last installed exactly it: an install there has nothing to do. */
export async function lockfileInstalled(root: string) {
  const { wanted, installed } = await lockfiles(root)
  return wanted !== undefined && wanted === installed
}

/**
 * Refuse to start a core on packages other than the lockfile's: code written for other versions type-checks against
 * nothing and fails only at runtime, after storage opened.
 */
export async function assertInstalled(root: string) {
  if (await installOwed(root))
    throw new Error(
      `The packages installed in ${root}/node_modules are not the ones pnpm-lock.yaml asks for. Run \`pnpm install --frozen-lockfile\` there, then start Ultimate again.`,
    )
}

/**
 * Install the lockfile's packages when they differ from the installed ones, from pnpm's store first and the registry
 * only when that fails; the install's last lines when it fails. `always` installs even when they match: pnpm can
 * write the installed lockfile and still fail after it.
 */
export async function installPackages(
  root: string,
  always = false,
): Promise<{ install: 'done' | 'failed' | 'skipped'; installError?: string }> {
  if (!always && !(await installOwed(root))) return { install: 'skipped' }
  // --ignore-scripts (fork-only, after the wfx-loot audit #261309): a landed package.json or dependency gets no
  // lifecycle script run on the host as it restarts; esbuild, the only dependency allowed to build, works without it.
  const install = (offline: string[]) =>
    exec('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', ...offline], {
      cwd: root,
      timeout: 10 * 60_000,
    })
  try {
    await install(['--offline']).catch(() => install([]))
    return { install: 'done' }
  } catch (error) {
    return { install: 'failed', installError: tail(error) }
  }
}

/** The last output lines of a failed command. */
function tail(error: unknown) {
  const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
  const output = `${stdout}${stderr}`.trim()
  return output ? output.split('\n').slice(-20).join('\n') : String(error)
}
