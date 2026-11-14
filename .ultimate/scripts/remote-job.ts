/**
 * Runs an eligible read-only background job on the tailnet PC via `ultimate-ci job` (#281756).
 * Contract: reads ULTIMATE_REMOTE_HOST, ULTIMATE_REMOTE_COMMAND, ULTIMATE_REMOTE_STATUS; writes one JSON object to
 * ULTIMATE_REMOTE_STATUS before exiting (or leaves no file if killed).
 */
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify, stripVTControlCharacters } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024
const PUSH_TIMEOUT_MS = 120_000
const MARKER_RE = /^ultimate-ci: job exit (\d+) setup (\d+) s run (\d+) s cpu (\d+) s$/

function looksLikeSecret(filePath: string): boolean {
  const base = path.posix.basename(filePath)
  if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) return true
  if (base.endsWith('.pem') || base.endsWith('.key')) return true
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519')) return true
  if (base === '.npmrc' || base === '.netrc') return true
  if (/^secrets.*\.json$/.test(base) || base.startsWith('credentials')) return true
  return false
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; trim?: boolean } = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
  })
  return options.trim === false ? stdout : stdout.trim()
}

function writeStatus(statusPath: string, payload: Record<string, unknown>) {
  writeFileSync(statusPath, `${JSON.stringify(payload)}\n`, 'utf8')
}

function failNoResult(statusPath: string | undefined, reason: string): never {
  const oneLine = reason.replace(/[\r\n]+/g, ' ').trim()
  process.stdout.write(`remote-job: ${oneLine}\n`)
  if (statusPath) writeStatus(statusPath, { ran: false, reason: oneLine })
  process.exit(75)
}

async function main() {
  const cwd = process.cwd()
  const host = process.env.ULTIMATE_REMOTE_HOST?.trim()
  const command = process.env.ULTIMATE_REMOTE_COMMAND
  const statusPath = process.env.ULTIMATE_REMOTE_STATUS?.trim()

  if (!host || !command || !statusPath) {
    failNoResult(
      statusPath,
      'missing ULTIMATE_REMOTE_HOST, ULTIMATE_REMOTE_COMMAND, or ULTIMATE_REMOTE_STATUS',
    )
  }

  // Fail closed before snapshotting if any untracked file looks like a secret or is larger than 5 MB.
  const untrackedRaw = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], {
    trim: false,
  })
  for (const file of untrackedRaw.split('\0')) {
    if (!file) continue
    if (looksLikeSecret(file)) failNoResult(statusPath, `untracked ${file} looks like a secret`)
    const stat = lstatSync(path.join(cwd, file))
    if (stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
      failNoResult(statusPath, `untracked ${file} is larger than 5 MB`)
    }
  }

  const transferStart = performance.now()
  const realIndexRel = await git(cwd, ['rev-parse', '--git-path', 'index'])
  const realIndex = path.resolve(cwd, realIndexRel)
  const tempIndex = path.join(os.tmpdir(), `ultimate-remote-index-${process.pid}-${Date.now()}`)

  const cleanupTempIndex = () => {
    try {
      rmSync(tempIndex, { force: true })
    } catch {
      // Best-effort cleanup of temp index file.
    }
  }
  const onSignal = (sig: NodeJS.Signals) => {
    cleanupTempIndex()
    process.kill(process.pid, sig)
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  let sha: string
  try {
    if (existsSync(realIndex)) copyFileSync(realIndex, tempIndex)
    const snapshotEnv: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tempIndex }
    await git(cwd, ['add', '-A'], { env: snapshotEnv })
    const tree = await git(cwd, ['write-tree'], { env: snapshotEnv })
    const headTree = await git(cwd, ['rev-parse', 'HEAD^{tree}'])
    const headSha = await git(cwd, ['rev-parse', 'HEAD'])
    if (tree === headTree) {
      sha = headSha
    } else {
      sha = await git(cwd, ['commit-tree', tree, '-p', headSha, '-m', 'remote job snapshot'], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ultimate',
          GIT_AUTHOR_EMAIL: 'ultimate@example.com',
          GIT_COMMITTER_NAME: 'Ultimate',
          GIT_COMMITTER_EMAIL: 'ultimate@example.com',
        },
      })
    }
  } finally {
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
    cleanupTempIndex()
  }

  // `scripts/changes.ts` (used by `pnpm check:changed` and `scripts/tests-for.ts`) runs `git merge-base HEAD main`,
  // so push local `main` alongside the snapshot when the repo has it (#281756).
  const hasMain = await git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).then(
    () => true,
    // Repo has no local `main` branch (e.g. a standalone fixture); skip pushing it.
    () => false,
  )
  const pushRefs = [
    `${sha}:refs/heads/job/${sha}`,
    ...(hasMain ? ['+refs/heads/main:refs/heads/main'] : []),
  ]

  try {
    await execFileAsync('git', ['push', '-q', `${host}:ci.git`, ...pushRefs], {
      cwd,
      timeout: PUSH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } catch (error) {
    const { stderr, killed } = error as { stderr?: string; killed?: boolean }
    const why = killed
      ? `push timed out after ${PUSH_TIMEOUT_MS / 1000} s`
      : (stderr?.trim() || (error as Error).message).split('\n')[0]
    failNoResult(statusPath, `pushing to ${host} failed: ${why}`)
  }

  const transferSeconds = Math.round(((performance.now() - transferStart) / 1000) * 10) / 10
  const encoded = Buffer.from(command, 'utf8').toString('base64')

  let marker:
    | { exitCode: number; setupSeconds: number; runSeconds: number; cpuSeconds: number }
    | undefined
  let last = ''

  const handleLine = (line: string) => {
    const plain = stripVTControlCharacters(line).trim()
    if (plain === 'ultimate-ci: alive') return
    const match = MARKER_RE.exec(plain)
    if (match) {
      marker = {
        exitCode: Number(match[1]),
        setupSeconds: Number(match[2]),
        runSeconds: Number(match[3]),
        cpuSeconds: Number(match[4]),
      }
      return
    }
    if (plain) last = plain
    process.stdout.write(`${line}\n`)
  }

  const { code, ended } = await new Promise<{ code: number | null; ended: string }>((done) => {
    const child = spawn('ssh', [host, 'job', sha, encoded], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    createInterface({ input: child.stdout }).on('line', handleLine)
    createInterface({ input: child.stderr }).on('line', handleLine)
    child.on('error', (error) => done({ code: null, ended: `ssh failed: ${error.message}` }))
    child.on('close', (exit, killed) =>
      done({ code: exit, ended: exit === null ? `ssh killed by ${killed}` : `exit ${exit}` }),
    )
  })

  if (marker) {
    process.stdout.write(
      `remote-job: ran on ${host} (transfer ${transferSeconds} s, setup ${marker.setupSeconds} s, cpu ${marker.cpuSeconds} s)\n`,
    )
    writeStatus(statusPath, {
      ran: true,
      transferSeconds,
      setupSeconds: marker.setupSeconds,
      cpuSeconds: marker.cpuSeconds,
    })
    process.exit(marker.exitCode)
  }

  if (code === 75 && last.includes('busy with another run')) {
    failNoResult(statusPath, `${host} is busy with another run`)
  }
  const detail = last ? `: ${last}` : ''
  failNoResult(statusPath, `${host} gave no result (${ended})${detail}`)
}

main().catch((error) =>
  failNoResult(
    process.env.ULTIMATE_REMOTE_STATUS?.trim(),
    error instanceof Error ? error.message : String(error),
  ),
)
