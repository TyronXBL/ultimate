/**
 * What an incoming range of commits changes that runs code by itself: on `pnpm install` here, in GitHub Actions, or
 * when an editor opens the folder, plus the published signs of the wfx-loot and GhostAction campaigns. Written after
 * the wfx-loot audit (#261309): the daily upstream merge brings another account's commits onto this host, where
 * installs, checks and the live reload run them. A report, never a gate: it prints and exits 0, and the merge branch
 * reads it before installing anything.
 *
 * Usage: node scripts/incoming-check.ts [<base>..<head>]   (default HEAD..origin/main)
 */
import { execFileSync } from 'node:child_process'

type Manifest = { scripts?: Record<string, string> }

/** The git output and package.json files of a range, as the check reads them. */
type Incoming = {
  /** `git log --format=%h%x09%s`: one commit a line. */
  commits: string
  /** `git diff --name-status --no-renames`. */
  files: string
  /** `git diff --unified=0 --no-color`. */
  patch: string
  /** Each changed package.json before and after the range; undefined where it does not exist. */
  manifests: { path: string; before?: Manifest; after?: Manifest }[]
  /** pnpm-workspace.yaml before and after the range, when the range changes it. */
  workspace?: { before?: string; after?: string }
}

// Aikido's indicators, https://www.aikido.dev/blog/compromised-github-accounts-push-ci-secret-stealer-to-tens-of-thousands-of-repositories
const TITLES = new Set([
  'docs: dependency audit notes',
  'ci: refresh build cache',
  'ci: restore',
  'chore: add ci helper',
  'ci: cleanup',
  'chore: add dependency audit workflow',
])
const MARKERS = [
  '194.150.166.244',
  '18.143.168.96',
  '193.32.204.199',
  'WFX-BEGIN',
  'wfx-loot',
  'toJSON(secrets)',
]
const IOC_FILES = /(^|\/)(\.ci-[a-z0-9]+\.sh|build-audit-[a-z0-9]+\.ya?ml|fa-solid-400\.woff2)$/
/** Scripts pnpm runs on install by itself. */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']
/** pnpm-workspace.yaml settings that decide what an install may fetch or run, and the advisories it lets pass. */
const INSTALL_POLICY = [
  'allowBuilds',
  'auditConfig',
  'blockExoticSubdeps',
  'dangerouslyAllowAllBuilds',
  'ignoreScripts',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'minimumReleaseAgeStrict',
  'overrides',
  'registries',
  'strictDepBuilds',
  'trustPolicy',
]

/** The lines of each top-level key of a YAML file (its own line and the indented ones under it), comments left out. */
function sections(yaml = '') {
  const found = new Map<string, Set<string>>()
  let key = ''
  for (const line of yaml.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) key = line.split(':')[0]
    found.set(key, (found.get(key) ?? new Set()).add(line.trim()))
  }
  return found
}

/** Why `path` runs by itself when a range changes it, or undefined. */
function pathRisk(status: string, path: string) {
  if (IOC_FILES.test(path)) return 'a file name the wfx-loot or GhostAction payload uses'
  if (path.startsWith('.github/')) return 'runs in GitHub Actions'
  if (/^\.(vscode|idea|devcontainer)\//.test(path))
    return 'editor configuration, which can run a task when the folder opens'
  if (path.startsWith('patches/')) return "patches a dependency's installed code"
  if (/(^|\/)(\.npmrc|\.?pnpmfile\.[cm]?js)$/.test(path)) return 'install configuration'
  if (status === 'A' && !path.includes('/') && /\.(sh|bash|[cm]?[jt]s|py)$/.test(path))
    return 'a new script at the top of the repository'
  return undefined
}

/** One line per thing in `incoming` to read before installing it, in the order found. */
export function incomingFlags(incoming: Incoming) {
  const flags: string[] = []
  for (const line of incoming.commits.split('\n').filter(Boolean)) {
    const [sha, subject] = line.split('\t')
    if (TITLES.has(subject)) flags.push(`${sha} "${subject}": a wfx-loot commit title`)
  }
  for (const line of incoming.files.split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t')
    const risk = status === 'D' ? undefined : pathRisk(status, path)
    if (risk) flags.push(`${path}: ${risk}`)
  }
  let file = ''
  let hunk = false
  for (const line of incoming.patch.split('\n')) {
    if (line.startsWith('diff ')) [file, hunk] = ['', false]
    else if (!hunk && line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '')
    else if (line.startsWith('@@')) hunk = true
    else if (hunk && line.startsWith('+')) {
      const added = line.slice(1)
      const marker = MARKERS.find((text) => added.includes(text))
      if (marker) flags.push(`${file}: adds "${marker}", a wfx-loot or GhostAction indicator`)
    }
  }
  if (incoming.workspace) {
    const before = sections(incoming.workspace.before)
    const after = sections(incoming.workspace.after)
    for (const key of INSTALL_POLICY)
      for (const line of after.get(key) ?? [])
        if (!before.get(key)?.has(line))
          flags.push(
            `pnpm-workspace.yaml: ${key} gains "${line}", which decides what an install fetches or runs`,
          )
  }
  for (const { path, before, after } of incoming.manifests)
    for (const name of LIFECYCLE) {
      const script = after?.scripts?.[name]
      if (script !== undefined && script !== before?.scripts?.[name])
        flags.push(`${path}: scripts.${name} "${script}" runs on every install`)
    }
  return flags
}

if (import.meta.main) {
  const range = process.argv[2] ?? 'HEAD..origin/main'
  const [base, head] = range.split(/\.{2,3}/)
  // A failing git (a wrong range) throws and exits nonzero with no report: the skill stops the merge then.
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
  const fork = git('merge-base', base, head).trim()
  const files = git('diff', '--name-status', '--no-renames', fork, head)
  const changed = files.split('\n').flatMap((line) => line.split('\t')[1] ?? [])
  const text = (revision: string, path: string) => {
    try {
      return git('show', `${revision}:${path}`)
    } catch {
      // Absent on that side: added or deleted by the range.
      return undefined
    }
  }
  const json = (revision: string, path: string) => {
    const source = text(revision, path)
    try {
      return source === undefined ? undefined : (JSON.parse(source) as Manifest)
    } catch {
      // Not JSON: no scripts there to compare.
      return undefined
    }
  }
  const flags = incomingFlags({
    commits: git('log', '--format=%h%x09%s', range),
    files,
    // Fixed prefixes, whatever diff.noprefix or diff.mnemonicPrefix say: the parser reads `+++ b/<path>`.
    patch: git(
      'diff',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      fork,
      head,
    ),
    manifests: changed
      .filter((path) => path.endsWith('package.json'))
      .map((path) => ({ path, before: json(fork, path), after: json(head, path) })),
    ...(changed.includes('pnpm-workspace.yaml')
      ? {
          workspace: {
            before: text(fork, 'pnpm-workspace.yaml'),
            after: text(head, 'pnpm-workspace.yaml'),
          },
        }
      : {}),
  })
  console.log(
    flags.length
      ? `incoming-check: ${flags.length} thing(s) in ${range} run by themselves; read them before installing:\n${flags.map((flag) => `- ${flag}`).join('\n')}`
      : `incoming-check: nothing in ${range} runs on install, in CI or in an editor by itself`,
  )
}
