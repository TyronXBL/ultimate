/** Whether the Chromium the browser tools launch is out of date, read offline: its own version, a recorded minimum and the system package manager's local database. */
import { realpath } from 'node:fs/promises'
import { exec } from '../../lib/exec.ts'
import type { ChromiumStatus } from './api.ts'

/**
 * The oldest Chromium without a hole Ultimate knows of. 156.0.8078.73 (27 October 2026) fixed CVE-2026-118306,
 * -118331, -118344 and -118348: sandbox escape and remote code execution. Raise it after the next such advisory.
 */
export const MINIMUM_CHROMIUM = '156.0.8078.73'

const VERSION = /\d+\.\d+\.\d+\.\d+/

/** Whether dotted version `a` is older than `b`, comparing every part. */
function older(a: string, b: string) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number))
  const index = x.findIndex((part, at) => part !== y[at])
  return index >= 0 && x[index] < y[index]
}

const quiet = { timeout: 10_000 }

/** The newer version and update command the system package manager has for the package owning `path`, if any. */
async function offered(path: string) {
  const file = await realpath(path)
  try {
    const owner = (await exec('pacman', ['-Qqo', file], quiet)).stdout.trim()
    const version = (await exec('pacman', ['-Si', owner], quiet)).stdout.match(VERSION)?.[0]
    if (version) return { version, update: `sudo pacman -Syu ${owner}` }
  } catch {
    // Not pacman, or no package owns the file: try the next package manager.
  }
  try {
    const owner = (await exec('dpkg-query', ['-S', file], quiet)).stdout.split(':')[0]
    const candidate = (await exec('apt-cache', ['policy', owner], quiet)).stdout
      .match(/Candidate:.*/)?.[0]
      .match(VERSION)?.[0]
    if (candidate) return { version: candidate, update: `sudo apt install --only-upgrade ${owner}` }
  } catch {
    // Not apt either, or no package owns the file: only the recorded minimum applies.
  }
  return undefined
}

/** `path`'s version and, when it is out of date, why and how to update it. */
export async function chromiumStatus(path: string): Promise<ChromiumStatus> {
  const version = (await exec(path, ['--version'], quiet)).stdout.match(VERSION)?.[0]
  if (!version) return { path }
  const newer = await offered(path)
  const reasons = [
    ...(older(version, MINIMUM_CHROMIUM)
      ? [`known sandbox escapes, fixed in ${MINIMUM_CHROMIUM}`]
      : []),
    ...(newer && older(version, newer.version) ? [`${newer.version} is available`] : []),
  ]
  return reasons.length
    ? { path, version, stale: reasons.join('; '), update: newer?.update }
    : { path, version }
}
