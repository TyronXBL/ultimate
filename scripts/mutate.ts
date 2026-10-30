/**
 * Mutation testing with StrykerJS, a report and never a gate: which small changes to the code no test notices.
 *
 *   node scripts/mutate.ts                     the whole allowlist, incrementally (the weekly run, .github/workflows/mutation.yml)
 *   node scripts/mutate.ts --changed [base]    only the allowlisted lines this branch changed against base (default: main)
 *   node scripts/mutate.ts --latest [remote]   download the newest weekly report from the remote's GitHub repo (default: fork)
 *   node scripts/mutate.ts --report [paths…]   print the downloaded report's summary, limited to paths
 *
 * Each prints the surviving mutants and the score over covered mutants; a mutant no selected test reaches is left out.
 * Only pure tests run: test files that import a mutated file directly and boot no server, which would cost seconds per
 * mutant. Reports go to reports/mutation/.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Stryker } from '@stryker-mutator/core'

/** `lib/` and the extension modules that pure tests import directly. */
const extensionModules = [
  'extensions/automations/schedule.ts',
  'extensions/codemode/summary.ts',
  'extensions/context/breakdown.ts',
  'extensions/conversations/context.ts',
  'extensions/conversations/summary-model.ts',
  'extensions/instance/cleanup.ts',
  'extensions/instance/links.ts',
  'extensions/keep-warm/due.ts',
  'extensions/review/comments.ts',
  'extensions/review/sha256.ts',
  'extensions/secrets/store.ts',
  'extensions/update/clone.ts',
  'extensions/voice-live/relay.ts',
]
const reportFile = 'reports/mutation/mutation.json'

const git = (args: string[], input?: string) =>
  execFileSync('git', args, { encoding: 'utf8', input }).trim()
const lines = (text: string) => text.split('\n').filter(Boolean)

const allowlist = [
  ...lines(git(['ls-files', 'lib'])).filter((file) => file.endsWith('.ts')),
  ...extensionModules,
]
const heavy =
  /fauxServer|prepareFauxServer|sourceCopy|trimmedSourceCopy|createServer|server\/harness\.ts|server\/extensions\.ts/

/** The pure test files that import one of `files` directly. */
const pureTests = (files: string[]) =>
  lines(git(['ls-files', 'test'])).filter((test) => {
    if (!/^test\/[^/]+\.test\.ts$/.test(test)) return false
    const text = readFileSync(test, 'utf8')
    return !heavy.test(text) && files.some((file) => text.includes(`'../${file}'`))
  })

/** `file:start-end` for each hunk this branch added or changed in an allowlisted file, committed or not. */
function changedRanges(base: string) {
  const ranges: string[] = []
  let file = ''
  for (const line of lines(git(['diff', '--unified=0', base, '--', ...allowlist]))) {
    if (line.startsWith('+++ ')) file = line.slice('+++ b/'.length)
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
    const count = Number(hunk?.[2] ?? 1)
    if (hunk && count > 0) ranges.push(`${file}:${hunk[1]}-${Number(hunk[1]) + count - 1}`)
  }
  return ranges
}

async function run(mutate: string[], changed: boolean) {
  process.env.MUTATE_TESTS = JSON.stringify(pureTests(mutate.map((entry) => entry.split(':')[0])))
  await new Stryker({
    mutate,
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    vitest: { configFile: 'test/mutation.config.ts', related: false },
    // TypeScript 7 has no `parseConfigFileTextToJson`, which Stryker's tsconfig rewriting calls: naming a file that
    // doesn't exist skips that step. Nothing else needs a tsconfig here; Vitest transforms the TypeScript itself.
    tsconfigFile: 'no-tsconfig.json',
    // Mutants in code that runs at import would rerun every test; they are skipped, not reported.
    ignoreStatic: true,
    reporters: ['progress', 'html', 'json'],
    // The weekly run keeps every test that kills a mutant (`killedBy`), the evidence for tests that catch nothing
    // another test doesn't, and reuses the previous results; a branch run stops at the first failing test.
    disableBail: !changed,
    incremental: !changed,
    incrementalFile: 'reports/stryker-incremental.json',
    // A branch run shares the machine with every other branch, the lander and previews.
    ...(changed ? { concurrency: 2 } : {}),
  }).runMutationTest()
}

type Mutant = {
  mutatorName: string
  replacement?: string
  status: string
  location: { start: { line: number; column: number }; end: { line: number; column: number } }
  killedBy?: string[]
}
type Report = {
  config?: { disableBail?: boolean }
  files: Record<string, { source: string; mutants: Mutant[] }>
  testFiles?: Record<string, { tests: { id: string; name: string }[] }>
}

const short = (text: string) => {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/** The code a mutant replaces: its location in the source, whose lines and columns count from 1. */
function original(source: string, { start, end }: Mutant['location']) {
  const rows = source.split('\n').slice(start.line - 1, end.line)
  rows[rows.length - 1] = rows.at(-1)!.slice(0, end.column - 1)
  rows[0] = rows[0].slice(start.column - 1)
  return rows.join('\n')
}

function summary(paths: string[] = []) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as Report
  const files = Object.entries(report.files).filter(
    ([file]) => !paths.length || paths.some((path) => file.startsWith(path)),
  )
  const mutants = files.flatMap(([file, entry]) =>
    entry.mutants.map((mutant) => ({ file, source: entry.source, ...mutant })),
  )
  const survived = mutants.filter((mutant) => mutant.status === 'Survived')
  for (const { file, source, location, mutatorName, replacement } of survived)
    console.log(
      `${file}:${location.start.line} ${mutatorName}: ${short(original(source, location))} → ${short(replacement ?? '')}`,
    )

  if (report.config?.disableBail) {
    const killers = mutants.flatMap((mutant) =>
      mutant.status === 'Killed' ? [mutant.killedBy ?? []] : [],
    )
    const unique = new Set(killers.filter((ids) => ids.length === 1).flat())
    const names = new Map(
      Object.entries(report.testFiles ?? {}).flatMap(([file, { tests }]) =>
        tests.map((test) => [test.id, `${file}: ${test.name}`]),
      ),
    )
    const redundant = [...new Set(killers.flat())].filter((id) => !unique.has(id))
    if (redundant.length) {
      console.log('\nTests without a unique kill (every mutant they kill, another test kills too):')
      for (const id of redundant) console.log(`  ${names.get(id) ?? id}`)
    }
  }

  const killed = mutants.filter(
    (mutant) => mutant.status === 'Killed' || mutant.status === 'Timeout',
  )
  const tested = killed.length + survived.length
  const score = tested ? ((killed.length / tested) * 100).toFixed(1) : '–'
  console.log(
    `\n${tested} mutants tested, ${survived.length} survived; score ${score} % of covered mutants`,
  )
}

/** The token Git stores for the repo, asked from its credential helpers without prompting; it goes only into headers. */
function token(repo: string) {
  const answer = git(
    ['-c', 'credential.interactive=false', 'credential', 'fill'],
    `protocol=https\nhost=github.com\npath=${repo}.git\n\n`,
  )
  const secret = /^password=(.+)$/m.exec(answer)?.[1]
  if (!secret) throw new Error(`no GitHub credential for ${repo}: artifact downloads need one`)
  return secret
}

/** Downloads the newest successful weekly run's report into reports/mutation/. */
async function latest(remote: string) {
  const repo = /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(git(['remote', 'get-url', remote]))?.[1]
  if (!repo) throw new Error(`${remote} is not a GitHub remote`)
  const secret = token(repo)
  const get = async (url: string) => {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${secret}` },
    })
    // A body that echoed the request would carry the token.
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status} ${(await response.text()).replaceAll(secret, '***').slice(0, 200)}`,
      )
    return response
  }
  const api = `https://api.github.com/repos/${repo}/actions`
  const { workflow_runs: runs } = (await (
    await get(`${api}/workflows/mutation.yml/runs?status=success&per_page=1`)
  ).json()) as { workflow_runs: { id: number; created_at: string; head_sha: string }[] }
  if (!runs.length) throw new Error(`no successful mutation.yml run on ${repo} yet`)
  const { artifacts } = (await (await get(`${api}/runs/${runs[0].id}/artifacts`)).json()) as {
    artifacts: { name: string; archive_download_url: string }[]
  }
  const artifact = artifacts.find((item) => item.name === 'mutation-report')
  if (!artifact) throw new Error(`run ${runs[0].id} has no mutation-report artifact`)
  const zip = Buffer.from(await (await get(artifact.archive_download_url)).arrayBuffer())
  rmSync('reports/mutation', { recursive: true, force: true })
  mkdirSync('reports/mutation', { recursive: true })
  writeFileSync('reports/mutation.zip', zip)
  execFileSync('bsdtar', ['-xf', 'reports/mutation.zip', '-C', 'reports/mutation'])
  rmSync('reports/mutation.zip')
  console.log(
    `Weekly report of ${runs[0].created_at} (${runs[0].head_sha.slice(0, 7)}) in reports/mutation/`,
  )
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    changed: { type: 'boolean' },
    latest: { type: 'boolean' },
    report: { type: 'boolean' },
  },
})

if (values.report) summary(positionals)
else if (values.latest) {
  await latest(positionals[0] ?? 'fork')
  summary()
} else if (values.changed) {
  const ranges = changedRanges(git(['merge-base', 'HEAD', positionals[0] ?? 'main']))
  if (!ranges.length) console.log('Nothing to mutate: this branch changed no allowlisted file.')
  else {
    await run(ranges, true)
    summary()
  }
} else {
  await run(allowlist, false)
  summary()
}
