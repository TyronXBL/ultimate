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

/** Whether `pnpm-lock.yaml` differs from what pnpm last installed (`node_modules/.pnpm/lock.yaml`). */
export async function installOwed(root: string) {
  const wanted = await wantedLockfile(root)
  return wanted !== undefined && wanted !== (await read(join(root, 'node_modules/.pnpm/lock.yaml')))
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
 * only when that fails; the install's last lines when it fails.
 */
export async function installPackages(
  root: string,
): Promise<{ install: 'done' | 'failed' | 'skipped'; installError?: string }> {
  if (!(await installOwed(root))) return { install: 'skipped' }
  const install = (offline: string[]) =>
    exec('pnpm', ['install', '--frozen-lockfile', ...offline], {
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
