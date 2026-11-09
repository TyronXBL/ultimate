// Run target-controlled code for a security audit offline, read-only and resource-bounded (SKILL.md, "Execution").
// Usage:
//   node sandbox.ts snapshot <repo> <rev> <out>   the exact tracked bytes of one commit, without filters, hooks or a checkout
//   node sandbox.ts selftest                       prove every control on this machine; exits 0 only when all of them hold
//   node sandbox.ts run --target <snapshot> --artifact <file.json> [options] -- <command> [args...]
// It fails closed: when a control cannot be set up or verified, the command does not run and the exit code is 125.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { constants as osConstants, homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

const MiB = 1024 * 1024
const SETUP_FAILED = 125
const TIMED_OUT = 124

class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message)
}

/** Whether `path` is `root` or inside it; both are real paths. */
const within = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const manifestPath = (snapshotRoot: string) => `${snapshotRoot}.snapshot.json`

type Manifest = {
  tool: 'security-audit/sandbox.ts'
  commit: string
  root: string
  files: number
  symlinks: number
  skipped: { path: string; reason: string }[]
  digest: string
}

/**
 * A digest of everything in a snapshot (paths, types, executable bits, contents, symlink targets), so a run can check
 * that its target is still exactly the snapshot that was made: unchanged bytes, nothing added, no symlink leaving it.
 * The empty `node_modules` folder `run --deps` makes as its mount point is not part of it.
 */
function digest(root: string) {
  const hash = createHash('sha256')
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir)).toSorted()) {
      const path = dir ? `${dir}/${name}` : name
      const full = join(root, path)
      const stat = lstatSync(full)
      if (stat.isDirectory()) {
        if (path === 'node_modules' && !readdirSync(full).length) continue
        hash.update(`d ${path}\0`)
        walk(path)
      } else if (stat.isFile()) {
        const content = readFileSync(full)
        hash
          .update(`f ${path} ${stat.mode & 0o111 ? 'x' : '-'} ${content.length}\0`)
          .update(content)
      } else if (stat.isSymbolicLink() && symlinkInside(path, readlinkSync(full))) {
        hash.update(`l ${path} ${readlinkSync(full)}\0`)
      } else refuse(`${full} is neither a file, a folder nor a symlink inside the snapshot`)
    }
  }
  walk('')
  return hash.digest('hex')
}

function git(repo: string, args: string[], input?: string) {
  // A partial clone would fetch missing objects over the network; this must stay a local read.
  const result = spawnSync('git', ['-C', repo, ...args], {
    input,
    maxBuffer: 1024 * MiB,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.status !== 0)
    refuse(`git ${args[0]} failed: ${result.stderr?.toString().trim() || result.error?.message}`)
  return result.stdout
}

/** A repository-relative path git could have written: no absolute, empty, `.`, `..` or `.git` component. */
const safeRepoPath = (path: string) =>
  !isAbsolute(path) &&
  path
    .split('/')
    .every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

/**
 * A symlink stays in the snapshot only when it resolves inside it: optional leading `..` steps from its own
 * directory, then plain names. A `..` after a name could climb out through another symlink, so it is refused.
 */
function symlinkInside(path: string, target: string) {
  if (isAbsolute(target)) return false
  const parts = target.split('/')
  const climbs = parts.findIndex((part) => part !== '..')
  if (parts.slice(climbs < 0 ? parts.length : climbs).some((part) => part === '..')) return false
  const resolved = posix.normalize(posix.join(posix.dirname(path), target))
  return resolved !== '..' && !resolved.startsWith('../')
}

/** Writes the tracked files of `rev` into the new directory `out`, and its manifest beside it. */
function snapshot(repo: string, rev: string, out: string): Manifest {
  const root = resolve(out)
  if (existsSync(root) || existsSync(manifestPath(root)))
    refuse(`${root} exists; snapshot into a new directory`)
  if (rev.startsWith('-')) refuse('the revision must not start with -')
  const commit = git(repo, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])
    .toString()
    .trim()
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit])
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode, type, oid] = line.slice(0, tab).split(' ')
      return { mode, type, oid, path: line.slice(tab + 1) }
    })
  const skipped: Manifest['skipped'] = []
  const blobs = entries.filter((entry) => entry.type === 'blob')
  for (const entry of entries)
    if (entry.type !== 'blob')
      skipped.push({ path: entry.path, reason: `${entry.type} not copied` })
  for (const entry of blobs)
    if (!safeRepoPath(entry.path)) refuse(`unsafe path in tree: ${entry.path}`)
  // One cat-file for every blob: raw object bytes, so no smudge filter, attribute or hook of the repository runs.
  const data = git(repo, ['cat-file', '--batch'], blobs.map((entry) => entry.oid).join('\n') + '\n')
  const contents = new Map<string, Buffer>()
  let at = 0
  for (const entry of blobs) {
    const end = data.indexOf(10, at)
    const [oid, type, size] = data.subarray(at, end).toString().split(' ')
    if (oid !== entry.oid || type !== 'blob')
      refuse(`git cat-file returned ${type} for ${entry.path}`)
    contents.set(entry.path, data.subarray(end + 1, end + 1 + Number(size)))
    at = end + 2 + Number(size)
  }
  mkdirSync(dirname(root), { recursive: true })
  mkdirSync(root)
  const files = blobs.filter((entry) => entry.mode !== '120000')
  for (const entry of files) {
    const file = join(root, entry.path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents.get(entry.path)!, {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    })
  }
  // Symlinks last, so no later write passes through one.
  let symlinks = 0
  for (const entry of blobs.filter((blob) => blob.mode === '120000')) {
    const target = contents.get(entry.path)!.toString()
    if (!symlinkInside(entry.path, target)) {
      skipped.push({ path: entry.path, reason: `symlink to ${target} leaves the snapshot` })
      continue
    }
    mkdirSync(dirname(join(root, entry.path)), { recursive: true })
    symlinkSync(target, join(root, entry.path))
    symlinks++
  }
  const manifest: Manifest = {
    tool: 'security-audit/sandbox.ts',
    commit,
    root: realpathSync(root),
    files: files.length,
    symlinks,
    skipped,
    digest: digest(root),
  }
  writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return manifest
}

type RunOptions = {
  target: string
  artifact: string
  deps?: string
  cwd: string
  memoryMiB: number
  tasks: number
  cpuPercent: number
  timeoutSeconds: number
  scratchMiB: number
  outputKiB: number
  env: [string, string][]
  command: string[]
}

const RESERVED_ENV = new Set(['PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'LANG'])
const LIMITS = {
  memory: { default: 1024, max: 3072 },
  tasks: { default: 128, max: 1024 },
  cpu: { default: 100, max: 400 },
  timeout: { default: 300, max: 3600 },
  scratch: { default: 256, max: 2048 },
  output: { default: 1024, max: 16384 },
} as const

function parseRun(args: string[]): RunOptions {
  const split = args.indexOf('--')
  if (split < 0 || split === args.length - 1) refuse('give the command after --')
  const options: Record<string, string> = {}
  const env: [string, string][] = []
  const flags = args.slice(0, split)
  for (let i = 0; i < flags.length; i += 2) {
    const [flag, value] = [flags[i], flags[i + 1]]
    if (!flag.startsWith('--') || value === undefined)
      refuse(`expected --option value, got ${flag}`)
    const name = flag.slice(2)
    if (name === 'env') {
      const eq = value.indexOf('=')
      const key = value.slice(0, eq)
      if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        refuse(`--env takes NAME=VALUE, got ${value}`)
      if (RESERVED_ENV.has(key)) refuse(`--env cannot set ${key}; the sandbox sets it`)
      env.push([key, value.slice(eq + 1)])
    } else if (['target', 'artifact', 'deps', 'cwd', ...Object.keys(LIMITS)].includes(name)) {
      if (name in options) refuse(`--${name} given twice`)
      options[name] = value
    } else refuse(`unknown option --${name}`)
  }
  const limit = (name: keyof typeof LIMITS) => {
    const raw = options[name] ?? String(LIMITS[name].default)
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || value < 1 || value > LIMITS[name].max)
      refuse(`--${name} must be an integer from 1 to ${LIMITS[name].max}`)
    return value
  }
  if (!options.target || !options.artifact) refuse('--target and --artifact are required')
  return {
    target: options.target,
    artifact: options.artifact,
    deps: options.deps,
    cwd: options.cwd ?? '.',
    memoryMiB: limit('memory'),
    tasks: limit('tasks'),
    cpuPercent: limit('cpu'),
    timeoutSeconds: limit('timeout'),
    scratchMiB: limit('scratch'),
    outputKiB: limit('output'),
    env,
    command: args.slice(split + 1),
  }
}

/**
 * The host's toolchain, read-only at the same paths: `/usr` (system files every local user can read), the root links
 * into it, and Node's binary alone when it lives elsewhere (an nvm install in the home folder), at `/toolchain/bin`
 * so none of its host folders appear in the sandbox.
 */
function toolchain() {
  const args = ['--ro-bind', '/usr', '/usr']
  for (const dir of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
    const stat = lstatSync(dir, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) args.push('--symlink', readlinkSync(dir), dir)
    else if (stat?.isDirectory()) args.push('--ro-bind', dir, dir)
  }
  for (const path of ['/etc/ld.so.cache', '/etc/alternatives'])
    if (existsSync(path)) args.push('--ro-bind', path, path)
  const path = ['/usr/bin', '/bin']
  const node = realpathSync(process.execPath)
  if (!node.startsWith('/usr/')) {
    args.push('--ro-bind', node, '/toolchain/bin/node')
    path.unshift('/toolchain/bin')
  }
  return { args, path: path.join(':') }
}

/**
 * The last step inside the sandbox, after every mount, limit and chdir is in place: it reports the start on fd 3,
 * closes it so the target cannot write there, and becomes the command (through `env`, since bash exports SHLVL even
 * after an unset). Without that report the run did not start.
 */
const START = `printf started >&3 || exit ${SETUP_FAILED}
exec 3>&-
exec /usr/bin/env -u SHLVL -- "$@"`

/** Run inside the scope before the sandbox starts: the cgroup limits must be the ones asked for, or nothing runs. */
const PREFLIGHT = `cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)
[ "$(cat "$cg/memory.max")" = "$1" ] && [ "$(cat "$cg/memory.swap.max")" = 0 ] &&
[ "$(cat "$cg/pids.max")" = "$2" ] && [ "$(cat "$cg/cpu.max")" = "$3 100000" ] ||
{ echo "sandbox: the cgroup limits are not in force" >&2; exit ${SETUP_FAILED}; }
shift 3
exec "$@"`

function which(binary: string) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const path = join(dir, binary)
    if (dir && existsSync(path)) return path
  }
  return refuse(`${binary} is not installed; target code cannot run here`)
}

type RunResult = {
  started: boolean
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  exit: number
}

/** Checks the paths, starts the sandbox in a limited systemd scope and writes the transcript to the artifact. */
async function runSandbox(options: RunOptions, quiet = false): Promise<RunResult> {
  const home = realpathSync(homedir())
  const target = realpathSync(options.target)
  if (!statSync(target).isDirectory()) refuse(`${target} is not a directory`)
  if (within(home, target)) refuse(`${target} is the home folder or contains it`)
  const manifestFile = manifestPath(target)
  const manifest = existsSync(manifestFile)
    ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest)
    : undefined
  if (manifest?.tool !== 'security-audit/sandbox.ts' || manifest.root !== target)
    refuse(
      `${target} is not a snapshot; make one with: node sandbox.ts snapshot <repo> <rev> <out>`,
    )
  if (digest(target) !== manifest.digest)
    refuse(`${target} differs from the snapshot of ${manifest.commit}; make a new one`)
  if (options.cwd !== '.' && !safeRepoPath(options.cwd))
    refuse(`--cwd ${options.cwd} leaves the target`)
  if (!statSync(join(target, options.cwd), { throwIfNoEntry: false })?.isDirectory())
    refuse(`--cwd ${options.cwd} is not a folder in the target`)
  const exposed = [target]
  let deps: string | undefined
  if (options.deps) {
    deps = realpathSync(options.deps)
    if (basename(deps) !== 'node_modules' || !statSync(deps).isDirectory())
      refuse('--deps must be a node_modules folder')
    if (within(home, deps)) refuse(`${deps} contains the home folder`)
    exposed.push(deps)
    // The mount point, made by this trusted code: the snapshot is read-only inside the sandbox.
    const mount = join(target, 'node_modules')
    if (!existsSync(mount)) mkdirSync(mount)
  }
  const artifact = resolve(options.artifact)
  // Checked on the real path of its nearest existing folder, before any folder is made.
  let existing = dirname(artifact)
  while (!existsSync(existing)) existing = dirname(existing)
  const artifactDir = join(realpathSync(existing), relative(existing, dirname(artifact)))
  if (exposed.some((root) => within(artifactDir, root)))
    refuse('the artifact must be outside everything the sandbox sees')
  if (options.scratchMiB >= options.memoryMiB)
    refuse('--scratch must be below --memory: the scratch tmpfs counts against it')
  const bwrap = which('bwrap')
  const systemdRun = which('systemd-run')
  if (!existsSync('/usr/bin/prlimit')) refuse('/usr/bin/prlimit is not installed')
  const tools = toolchain()
  mkdirSync(artifactDir, { recursive: true })
  // Reserved before the run: an existing file, or a symlink in its place, refuses instead of being overwritten.
  let fd: number
  try {
    fd = openSync(
      artifact,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    return refuse(`cannot create the artifact ${artifact}: ${(error as Error).message}`)
  }

  const memory = options.memoryMiB * MiB
  const scratch = options.scratchMiB * MiB
  const cwd = options.cwd === '.' ? '/target' : `/target/${options.cwd}`
  const env: [string, string][] = [
    ['PATH', tools.path],
    ['HOME', '/scratch/home'],
    ['TMPDIR', '/scratch/tmp'],
    ['XDG_CACHE_HOME', '/scratch/cache'],
    ['LANG', 'C.UTF-8'],
    ...options.env,
  ]
  const flags = (pairs: string[][]) => pairs.flat()
  const sandbox = flags([
    ['--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net', '--unshare-uts'],
    ['--unshare-cgroup', '--disable-userns', '--die-with-parent', '--new-session', '--clearenv'],
    ['--hostname', 'sandbox', ...tools.args, '--proc', '/proc', '--dev', '/dev'],
    ['--size', String(scratch), '--tmpfs', '/scratch'],
    ['--dir', '/scratch/home', '--dir', '/scratch/tmp', '--dir', '/scratch/cache'],
    ['--symlink', '/scratch/tmp', '/tmp', '--ro-bind', target, '/target'],
    deps ? ['--ro-bind', deps, '/target/node_modules'] : [],
    ['--chdir', cwd, ...env.flatMap(([key, value]) => ['--setenv', key, value])],
    ['--', '/usr/bin/prlimit', `--fsize=${scratch}`, '--nofile=1024', '--core=0'],
    ['--', '/bin/sh', '-c', START, 'start', ...options.command],
  ])
  const scope = flags([
    ['--user', '--scope', '--quiet', '--collect'],
    ['-p', `MemoryMax=${memory}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${options.tasks}`],
    ['-p', `CPUQuota=${options.cpuPercent}%`, '-p', `RuntimeMaxSec=${options.timeoutSeconds}`],
    ['-p', 'TimeoutStopSec=1', '--', '/bin/sh', '-c', PREFLIGHT, 'preflight'],
    [String(memory), String(options.tasks), String(options.cpuPercent * 1000), bwrap, ...sandbox],
  ])

  const cap = options.outputKiB * 1024
  const started = Date.now()
  const child = spawn(systemdRun, scope, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })

  const capture = (stream: NodeJS.ReadableStream, echo: NodeJS.WriteStream) => {
    const kept: Buffer[] = []
    let size = 0
    let truncated = false
    stream.on('data', (chunk: Buffer) => {
      const room = cap - size
      if (chunk.length > room) truncated = true
      const part = chunk.subarray(0, Math.max(room, 0))
      if (!part.length) return
      kept.push(part)
      size += part.length
      if (!quiet) echo.write(part)
    })
    return () =>
      Buffer.concat(kept).toString() + (truncated ? `\n[truncated at ${cap} bytes]\n` : '')
  }
  const stdout = capture(child.stdout!, process.stdout)
  const stderr = capture(child.stderr!, process.stderr)
  let status = ''
  child.stdio[3]!.on('data', (chunk: Buffer) => (status += chunk.toString()))
  // systemd stops the scope at RuntimeMaxSec; this kill is the backstop if it does not.
  const backstop = setTimeout(() => child.kill('SIGKILL'), (options.timeoutSeconds + 5) * 1000)
  let spawnError = ''
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => {
    child.on('close', (exitCode, exitSignal) => done([exitCode, exitSignal]))
    // A spawn failure (EAGAIN, a missing binary) means nothing started.
    child.on('error', (error) => {
      spawnError = error.message
      done([null, null])
    })
  })
  clearTimeout(backstop)
  const durationMs = Date.now() - started
  const ran = status === 'started'
  const timedOut = ran && durationMs >= options.timeoutSeconds * 1000
  const exit = !ran
    ? SETUP_FAILED
    : timedOut
      ? TIMED_OUT
      : signal
        ? 128 + osConstants.signals[signal]
        : code!
  const result = {
    started: ran,
    code,
    signal,
    timedOut,
    durationMs,
    stdout: stdout(),
    stderr: stderr() + (spawnError && `sandbox: ${spawnError}\n`),
    exit,
  }
  // The transcript records the reproduction and only the variables set for it: no host paths, no ambient environment.
  const transcript = {
    tool: 'security-audit/sandbox.ts',
    target: { commit: manifest.commit, cwd, deps: deps ? 'node_modules' : null },
    command: options.command,
    env: Object.fromEntries(options.env),
    limits: {
      memoryMiB: options.memoryMiB,
      swap: 0,
      tasks: options.tasks,
      cpuPercent: options.cpuPercent,
      timeoutSeconds: options.timeoutSeconds,
      scratchMiB: options.scratchMiB,
      outputKiB: options.outputKiB,
    },
    isolation:
      'bubblewrap: no network (own loopback), empty environment, read-only target and toolchain, writes only to a scratch tmpfs discarded at exit',
    ...result,
  }
  // Paths the caller passed in arguments or output mentions are written relative to the home folder.
  writeSync(fd, JSON.stringify(transcript, null, 2).replaceAll(home, '~') + '\n')
  closeSync(fd)
  return result
}

/** Runs inside the sandbox during the selftest and prints what it could reach. */
const PROBE = `(async () => {
  const [port, home, canary, scratchMiB] = process.argv.slice(1)
  const fs = require('node:fs'), net = require('node:net'), dns = require('node:dns')
  process.on('SIGXFSZ', () => {})
  const write = (path, data = 'x') => { try { fs.writeFileSync(path, data); return 'written' } catch (e) { return e.code } }
  const connect = (host, port) => new Promise((done) => {
    const socket = net.connect({ host, port: Number(port), timeout: 3000 })
    socket.on('connect', () => { socket.destroy(); done('connected') })
    socket.on('timeout', () => { socket.destroy(); done('timeout') })
    socket.on('error', (e) => done(e.code))
  })
  let fill = 'written'
  try { for (let i = 0; i <= Number(scratchMiB); i++) fs.appendFileSync('/scratch/fill', Buffer.alloc(1 << 20)) }
  catch (e) { fill = e.code }
  fs.rmSync('/scratch/fill', { force: true })
  console.log(JSON.stringify({
    targetRead: fs.readFileSync('/target/data.txt', 'utf8'),
    targetWrite: write('/target/new.txt'),
    toolchainWrite: write('/usr/new.txt'),
    scratchWrite: write('/scratch/tmp/ok.txt'),
    tmpWrite: write('/tmp/ok.txt'),
    homeWrite: write(process.env.HOME + '/ok.txt'),
    scratchFill: fill,
    env: Object.keys(process.env).sort(),
    hostHome: fs.existsSync(home),
    canary: fs.existsSync(canary),
    run: fs.existsSync('/run'),
    sys: fs.existsSync('/sys'),
    hostLoopback: await connect('127.0.0.1', port),
    external: await connect('1.1.1.1', 443),
    dns: await new Promise((done) => dns.lookup('example.com', (e) => done(e ? e.code : 'resolved'))),
  }))
})()`

async function selftest() {
  const work = mkdtempSync(join(tmpdir(), 'security-audit-selftest-'))
  const listener = createServer((socket) => socket.end())
  const failures: string[] = []
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
    if (!ok) failures.push(name)
  }
  const refused = async (name: string, attempt: () => Promise<unknown>) => {
    try {
      await attempt()
      check(name, false, 'it ran')
    } catch (error) {
      check(name, error instanceof Refusal, (error as Error).message)
    }
  }
  try {
    // A synthetic repository with one file, one in-tree symlink and one symlink that leaves the tree.
    const repo = join(work, 'repo')
    mkdirSync(repo)
    writeFileSync(join(repo, 'data.txt'), 'fixture\n')
    symlinkSync('data.txt', join(repo, 'inside'))
    symlinkSync('../../outside', join(repo, 'escape'))
    const identity = ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid']
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      [...identity, 'commit', '-qm', 'fixture'],
    ])
      git(repo, ['-c', 'commit.gpgsign=false', ...args])
    const target = join(work, 'target')
    const manifest = snapshot(repo, 'HEAD', target)
    check(
      'snapshot copies tracked files',
      readFileSync(join(target, 'data.txt'), 'utf8') === 'fixture\n',
    )
    check('snapshot keeps in-tree symlinks', readlinkSync(join(target, 'inside')) === 'data.txt')
    check(
      'snapshot drops symlinks that leave it',
      !lstatSync(join(target, 'escape'), { throwIfNoEntry: false }) &&
        manifest.skipped.length === 1,
    )
    const canary = join(work, 'credentials', 'token')
    mkdirSync(dirname(canary))
    writeFileSync(canary, 'dummy credential\n', { mode: 0o600 })
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
    const port = (listener.address() as { port: number }).port
    const run = (name: string, overrides: Partial<RunOptions>) =>
      runSandbox(
        {
          target,
          artifact: join(work, 'agents', 'selftest', 'artifacts', `${name}.json`),
          cwd: '.',
          memoryMiB: 256,
          tasks: 64,
          cpuPercent: 100,
          timeoutSeconds: 30,
          scratchMiB: 16,
          outputKiB: 64,
          env: [['FIXTURE', 'dummy']],
          command: ['true'],
          ...overrides,
        },
        true,
      )

    // Found on the sandbox's PATH, wherever the host keeps it.
    const node = 'node'
    const probe = await run('probe', {
      command: [node, '-e', PROBE, String(port), realpathSync(homedir()), canary, '16'],
    })
    check('the sandbox starts', probe.exit === 0, probe.stderr.trim())
    const seen = JSON.parse(probe.stdout || '{}')
    // bwrap sets PWD to the --chdir folder.
    const allowed = ['FIXTURE', 'HOME', 'LANG', 'PATH', 'PWD', 'TMPDIR', 'XDG_CACHE_HOME']
    check('the target is readable', seen.targetRead === 'fixture\n')
    check('the target is read-only', seen.targetWrite === 'EROFS', seen.targetWrite)
    check('the toolchain is read-only', seen.toolchainWrite === 'EROFS', seen.toolchainWrite)
    check(
      'scratch, /tmp and HOME are writable',
      [seen.scratchWrite, seen.tmpWrite, seen.homeWrite].every((result) => result === 'written'),
    )
    check('scratch is bounded', ['ENOSPC', 'EFBIG'].includes(seen.scratchFill), seen.scratchFill)
    check(
      'the environment holds only the allowlist',
      JSON.stringify(seen.env) === JSON.stringify(allowed),
      seen.env?.join(' '),
    )
    check('the home folder is not visible', seen.hostHome === false)
    check('a file outside the target is not visible', seen.canary === false)
    check('/run and /sys (host sockets) are not mounted', seen.run === false && seen.sys === false)
    check(
      'host loopback services are unreachable',
      seen.hostLoopback === 'ECONNREFUSED',
      seen.hostLoopback,
    )
    check('the external network is unreachable', seen.external === 'ENETUNREACH', seen.external)
    check('DNS does not resolve', seen.dns !== 'resolved', seen.dns)

    const slow = await run('timeout', { timeoutSeconds: 2, command: ['sleep', '30'] })
    check('the wall-clock limit stops it', slow.exit === TIMED_OUT && slow.durationMs < 10_000)
    const hog = await run('memory', {
      memoryMiB: 64,
      command: [node, '-e', 'const a = []; for (;;) a.push(Buffer.alloc(16 << 20, 1))'],
    })
    check(
      'the memory limit stops it',
      hog.started && hog.exit !== 0 && !hog.timedOut,
      `exit ${hog.exit}`,
    )
    const forks = await run('tasks', {
      tasks: 24,
      command: [
        node,
        '-e',
        `const { spawn } = require('node:child_process'); let failed = 0, started = 0
         for (let i = 0; i < 40; i++) { const c = spawn('sleep', ['3']); c.on('spawn', () => started++); c.on('error', () => failed++) }
         setTimeout(() => console.log(JSON.stringify({ started, failed })), 1000)`,
      ],
    })
    const tasks = JSON.parse(forks.stdout || '{}')
    check('the process limit holds', tasks.failed > 0 && tasks.started < 24, forks.stdout.trim())
    const artifact = JSON.parse(
      readFileSync(join(work, 'agents', 'selftest', 'artifacts', 'probe.json'), 'utf8'),
    )
    check(
      'the transcript names the commit and no host path',
      artifact.target.commit === manifest.commit && !JSON.stringify(artifact).includes(target),
    )

    await refused('a home-folder target is refused', () => run('home', { target: homedir() }))
    await refused('a folder that is not a snapshot is refused', () => run('repo', { target: repo }))
    await refused('an artifact inside the target is refused', () =>
      run('inside', { artifact: join(target, 'out.json') }),
    )
    await refused('a --cwd that is not a folder is refused', () => run('cwd', { cwd: 'missing' }))
    writeFileSync(join(target, 'added.txt'), 'not in the commit\n')
    await refused('a changed snapshot is refused', () => run('changed', {}))
    rmSync(join(target, 'added.txt'))
    await refused('an existing artifact is not overwritten', () =>
      run('again', { artifact: join(work, 'agents', 'selftest', 'artifacts', 'probe.json') }),
    )
  } finally {
    listener.close()
    rmSync(work, { recursive: true, force: true })
  }
  console.log(failures.length ? `selftest FAILED: ${failures.join('; ')}` : 'selftest passed')
  return failures.length ? 1 : 0
}

async function main(args: string[]) {
  const [command, ...rest] = args
  if (command === 'snapshot' && rest.length === 3) {
    console.log(JSON.stringify(snapshot(rest[0], rest[1], rest[2]), null, 2))
    return 0
  }
  if (command === 'selftest' && rest.length === 0) return selftest()
  if (command === 'run') {
    const result = await runSandbox(parseRun(rest))
    console.error(
      `sandbox: ${result.started ? `exit ${result.exit}` : 'did not start'} after ${result.durationMs} ms`,
    )
    return result.exit
  }
  return refuse(
    'usage: sandbox.ts snapshot <repo> <rev> <out> | selftest | run --target <snapshot> --artifact <file> [options] -- <command>',
  )
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(`sandbox: ${(error as Error).message}`)
  process.exitCode = SETUP_FAILED
}
