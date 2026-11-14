import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it, vi } from 'vitest'
import { context, prepareHarness } from '../../server/harness.ts'
import type { OpenHost } from '../../server/harness.ts'
import ciExtension from '../../.ultimate/extensions/ci/server.ts'
import type { CiResult } from '../../.ultimate/extensions/ci/refs.ts'
import type { Run } from '../../.ultimate/extensions/ci/github.ts'
import { resultIn } from '../../extensions/conversations/server.ts'
import { temp, until as waitFor } from '../helpers.ts'

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) =>
  run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
// Moves the poll's sleeps along while the shared helper measures real IO against a real deadline.
const until = (test: () => boolean | Promise<boolean>) =>
  waitFor(test, 20_000, () => vi.advanceTimersByTimeAsync(5_000))

const TOKEN = 'stored-fork-token-1234'
const hosts: OpenHost[] = []
const searchPath = process.env.PATH
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  vi.useRealTimers()
  delete process.env.CI_GATE_API
  process.env.PATH = searchPath
})

/**
 * A committed checkout for the lander's gate, and a `bin` folder for its search path with a `pnpm` that stands in for
 * every pnpm command (the audit, the check, the suites, the PC's install): it logs `<args> in <folder name>`, read back
 * by `calls`, and fails the subcommand `failing`.
 */
async function gateFixture(root: string, failing?: string) {
  const bin = join(root, 'bin')
  await mkdir(bin)
  const log = join(root, 'calls')
  await writeFile(
    join(bin, 'pnpm'),
    [
      '#!/bin/bash',
      `echo "$* in $(basename "$PWD")" >> ${log}`,
      'echo "stub pnpm $1"',
      ...(failing ? [`[[ $1 == ${failing} ]] && exit 1`] : []),
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = join(root, 'checkout')
  await mkdir(checkout)
  await git(checkout, 'init', '-q', '-b', 'main')
  await writeFile(join(checkout, 'a.txt'), 'a\n')
  await git(checkout, 'add', '.')
  await git(checkout, 'commit', '-qm', 'first')
  const sha = await git(checkout, 'rev-parse', 'HEAD')
  const calls = async () =>
    existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : []
  return { bin, checkout, sha, log, calls }
}

/** Run the gate in `checkout` with `bin` first on the search path and GitHub's API at `api`: its exit code and output. */
async function runGate(root: string, checkout: string, bin: string, api?: string) {
  try {
    const { stdout } = await run(
      process.execPath,
      [join(import.meta.dirname, '../../.ultimate/scripts/ci-gate.ts'), 'fork'],
      {
        cwd: checkout,
        env: {
          ...process.env,
          PATH: `${bin}:${searchPath}`,
          ...(api ? { CI_GATE_API: api } : {}),
          // No RAM floor in this home: the local suites are admitted at once.
          HOME: join(root, 'home'),
        },
      },
    )
    return { code: 0, stdout, last: stdout.trimEnd().split('\n').at(-1) }
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string }
    return { code, stdout, last: stdout.trimEnd().split('\n').at(-1) }
  }
}

/** The PC: a bare ci.git in its runner's home, reached by an `ssh` in `bin` that runs the real forced command there. */
async function pcRunner(root: string, bin: string) {
  const pcHome = join(root, 'pc')
  await mkdir(pcHome)
  await git(root, 'init', '-q', '--bare', join(pcHome, 'ci.git'))
  await writeFile(
    join(bin, 'ssh'),
    [
      '#!/bin/bash',
      'while [[ $1 == -* ]]; do case $1 in -o|-p|-i) shift 2;; *) shift;; esac; done',
      'shift',
      `HOME=${pcHome} SSH_ORIGINAL_COMMAND="$*" exec ${join(import.meta.dirname, '../../.ultimate/ci-runner/ultimate-ci')}`,
    ].join('\n'),
    { mode: 0o755 },
  )
  return pcHome
}

const failed: Run = { id: 7, status: 'completed', conclusion: 'failure', html_url: 'https://run/7' }
it.each<[string, Run[], boolean]>([
  ['', [], true],
  // #276750: a pass beside a failure of the commit was reported as "already passed", which the gate then refused.
  [
    ' beside an earlier pass and failure of the commit',
    [
      { id: 8, status: 'completed', conclusion: 'success', html_url: 'https://run/8' },
      { id: 9, status: 'completed', conclusion: 'failure', html_url: 'https://run/9' },
    ],
    true,
  ],
  // #276750: a run of the commit under way (the gate's) got a second, billed run beside it.
  [
    ' by waiting for a run of the commit under way, pushing nothing',
    [{ ...failed, status: 'in_progress', conclusion: null }],
    false,
  ],
])(
  'runs CI on the fork in the background and wakes the caller once with the failing tests%s',
  async (_case, earlier, pushes) => {
    const root = await temp('ultimate-ci-')
    // GitHub's git side: pushes to the fork's URL go to a local bare repository, which records every ref it receives.
    const github = join(root, 'github')
    await mkdir(join(github, 'owner'), { recursive: true })
    await git(root, 'init', '-q', '--bare', join(github, 'owner/ultimate.git'))
    const received = join(root, 'received')
    await writeFile(
      join(github, 'owner/ultimate.git/hooks/pre-receive'),
      `#!/bin/sh\ncat >> ${received}\n`,
      { mode: 0o755 },
    )
    const checkout = join(root, 'checkout')
    await mkdir(checkout)
    await git(checkout, 'init', '-q', '-b', 'main')
    await writeFile(join(checkout, 'a.txt'), 'a\n')
    await git(checkout, 'add', '.')
    await git(checkout, 'commit', '-qm', 'first')
    await git(checkout, 'remote', 'add', 'fork', 'https://github.com/owner/ultimate.git')
    await git(checkout, 'config', `url.${github}/.pushInsteadOf`, 'https://github.com/')
    await git(
      checkout,
      'config',
      'credential.helper',
      `!f() { echo username=owner; echo password=${TOKEN}; }; f`,
    )
    const sha = await git(checkout, 'rev-parse', 'HEAD')

    // GitHub's API side: the `earlier` runs of the commit on other refs, and run 7 on the ci/ ref once it was pushed (or
    // the earlier one under way), which failed with an annotated failing test. Every run has the same jobs.
    const seen: { path: string; authorization?: string }[] = []
    const api = createServer((request, response) => {
      seen.push({ path: request.url!, authorization: request.headers.authorization })
      const url = new URL(request.url!, 'http://api')
      const path = url.pathname
      const pushed =
        execFileSync('git', ['ls-remote', join(github, 'owner/ultimate.git'), 'refs/heads/ci/*'], {
          encoding: 'utf8',
        }) !== ''
      const id = /^\/repos\/owner\/ultimate\/actions\/runs\/(\d+)(\/jobs)?$/.exec(path)
      const body =
        path === '/repos/owner/ultimate/actions/runs'
          ? {
              workflow_runs: [
                ...(pushed ? [failed] : []),
                ...(url.searchParams.has('branch') ? [] : earlier),
              ],
            }
          : id && !id[2]
            ? [failed, ...earlier].find((item) => item.id === Number(id[1]))
            : id
              ? {
                  jobs: [
                    {
                      id: 1,
                      name: 'check',
                      conclusion: 'success',
                      started_at: '2026-01-01T00:00:00Z',
                      completed_at: '2026-01-01T00:00:20Z',
                    },
                    {
                      id: 2,
                      name: 'test (1/4)',
                      conclusion: 'failure',
                      started_at: '2026-01-01T00:00:05Z',
                      completed_at: '2026-01-01T00:01:05Z',
                    },
                  ],
                }
              : path === '/repos/owner/ultimate/check-runs/2/annotations'
                ? [
                    {
                      path: '.github',
                      start_line: 1,
                      message: 'Process completed with exit code 1.',
                      annotation_level: 'failure',
                    },
                    {
                      path: 'test/a.test.ts',
                      start_line: 3,
                      title: 'test/a.test.ts > adds',
                      message: 'AssertionError: expected 1 to be 2\nmore',
                      annotation_level: 'failure',
                    },
                  ]
                : undefined
      response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body ?? { message: 'Not Found' }))
    })
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', done))
    process.env.CI_GATE_API = `http://127.0.0.1:${(api.address() as AddressInfo).port}`

    const prepared = await prepareHarness({
      ultimateRoot: root,
      userHome: await temp(),
      home: join(root, 'home'),
      faux: fauxProvider(),
    })
    let opened: OpenHost
    prepared.registry.install(
      ciExtension({
        projectRoot: checkout,
        harness: () => opened.harness,
        need: (() => ({
          get: async () => undefined,
          resultIn,
          // The lander's record: the failing test also failed at two landings of another branch.
          failing: async ({ tests, except }: { tests: string[]; except: number }) =>
            tests.includes('test/a.test.ts > adds') && except === caller.id
              ? [
                  {
                    test: 'test/a.test.ts > adds',
                    landings: [
                      { submission: 's2', conversationId: 9, at: 2, sank: true },
                      { submission: 's1', conversationId: 9, at: 1, sank: false },
                    ],
                    branches: [9],
                  },
                ]
              : [],
        })) as never,
        onOpen: () => {},
        onClose: () => {},
      }),
    )
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('ci', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Started.')]),
      fauxAssistantMessage([fauxText('Read the result.')]),
    ])
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    opened = await prepared.open()
    hosts.push(opened)
    const caller = opened.root
    await caller.submit({ type: 'input', requestId: 'go', content: 'Run CI' }, context)

    const results = async () =>
      (await caller.context(context)).entries.filter((entry) => entry.kind === 'ci.result')
    await until(async () => (await results()).length > 0)
    await vi.advanceTimersByTimeAsync(120_000)
    const delivered = await results()
    expect(delivered).toHaveLength(1)
    const result = delivered[0].data as CiResult
    expect(result).toMatchObject({
      sha,
      conclusion: 'failure',
      url: 'https://run/7',
      seconds: 65,
      jobs: [
        { name: 'check', conclusion: 'success', seconds: 20 },
        { name: 'test (1/4)', conclusion: 'failure', seconds: 60 },
      ],
      failures: [
        {
          title: 'test/a.test.ts > adds',
          message: 'AssertionError: expected 1 to be 2',
          earlier: { landings: 2, branches: [9] },
        },
      ],
    })
    expect(existsSync(received)).toBe(pushes)
    // The run's ref is deleted once the run ended.
    expect(
      await git(checkout, 'ls-remote', join(github, 'owner/ultimate.git'), 'refs/heads/ci/*'),
    ).toBe('')
    // The stored credential authenticates every API call and appears nowhere else.
    expect(seen.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
    const transcript = JSON.stringify((await caller.context(context)).entries)
    expect(transcript).not.toContain(TOKEN)
    expect(transcript).toContain(
      'FAIL test/a.test.ts > adds: AssertionError: expected 1 to be 2 (also failed in 2 earlier landings: #9)',
    )
    api.close()
  },
)

it('refuses an uncommitted checkout instead of testing the HEAD before it', async () => {
  // #147838, #151003, #156344, #166097: `git commit` and `ci` in one tool round, and CI tested the commit before.
  const root = await temp('ultimate-ci-dirty-')
  const checkout = join(root, 'checkout')
  await mkdir(checkout)
  await git(checkout, 'init', '-q', '-b', 'main')
  await writeFile(join(checkout, 'a.txt'), 'a\n')
  await git(checkout, 'add', '.')
  await git(checkout, 'commit', '-qm', 'first')
  await writeFile(join(checkout, 'a.txt'), 'changed\n')
  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: await temp(),
    home: join(root, 'home'),
    faux: fauxProvider(),
  })
  let opened: OpenHost
  prepared.registry.install(
    ciExtension({
      projectRoot: checkout,
      harness: () => opened.harness,
      need: (() => ({ get: async () => undefined })) as never,
      onOpen: () => {},
      onClose: () => {},
    }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('ci', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Refused.')]),
  ])
  opened = await prepared.open()
  hosts.push(opened)
  await (
    await opened.root.submit({ type: 'input', requestId: 'go', content: 'Run CI' }, context)
  ).wait(context)
  const result = (await opened.root.context(context)).entries.find(
    (entry) => entry.kind === 'pi.tool-result',
  )
  expect(result?.model?.[0]).toMatchObject({ role: 'toolResult', isError: true })
  expect(JSON.stringify(result)).toContain(
    'Uncommitted changes in ' +
      checkout +
      ', so CI would not test them: M a.txt. Commit first, in its own tool round, then call ci again.',
  )
  expect(
    (await opened.harness.inspect(context)).tasks.some((t) => t.record.kind === 'ci.run'),
  ).toBe(false)
})

const here = (...commands: string[]) => commands.map((command) => `${command} in checkout`)
it.each<
  [
    string,
    {
      underWay: boolean
      failing?: string
      /** How the fallback banner starts, when GitHub gave no verdict. */
      banner?: string
      calls: string[]
      code: number
      last: (sha: string) => string
    },
  ]
>([
  [
    'a run of the commit under way whose jobs GitHub did not start for billing: all four here, nothing pushed',
    {
      underWay: true,
      banner:
        'CI GATE FALLBACK: GitHub Actions did not start the jobs: The job was not started because recent account payments have failed',
      calls: here('audit --audit-level high', 'check', 'test', 'test:e2e'),
      code: 0,
      last: () =>
        'ci-gate: FALLBACK: check, audit, test and test:e2e passed on this machine (CI was not used; waited for the run under way, https://run/7)',
    },
  ],
  [
    'no run of the commit, its push refused: the audit and check before the push, after it only the suites',
    {
      underWay: false,
      banner: 'CI GATE FALLBACK: pushing ci/',
      calls: [...here('audit --audit-level high', 'check'), 'push', ...here('test', 'test:e2e')],
      code: 0,
      last: (sha) =>
        `ci-gate: FALLBACK: check, audit, test and test:e2e passed on this machine (CI was not used; no CI run of ${sha.slice(0, 7)})`,
    },
  ],
  [
    'no run of the commit and a failing check: the gate fails without a push',
    {
      underWay: false,
      failing: 'check',
      calls: here('audit --audit-level high', 'check'),
      code: 1,
      last: () => 'ci-gate: pnpm check failed on this machine (exit 1)',
    },
  ],
])('runs on this machine what no CI run covers: %s', async (_case, expected) => {
  const root = await temp('ultimate-ci-gate-')
  const { bin, checkout, sha, log, calls } = await gateFixture(root, expected.failing)
  // GitHub's git side refuses every push, after noting it among the calls.
  const github = join(root, 'github')
  await mkdir(join(github, 'owner'), { recursive: true })
  await git(root, 'init', '-q', '--bare', join(github, 'owner/ultimate.git'))
  await writeFile(
    join(github, 'owner/ultimate.git/hooks/pre-receive'),
    `#!/bin/sh\necho push >> ${log}\nexit 1\n`,
    { mode: 0o755 },
  )
  await git(checkout, 'remote', 'add', 'fork', 'https://github.com/owner/ultimate.git')
  await git(checkout, 'config', `url.${github}/.pushInsteadOf`, 'https://github.com/')
  await git(checkout, 'config', 'credential.helper', `!f() { echo password=${TOKEN}; }; f`)
  // A run of the commit already under way, whose jobs GitHub refuses to start once the month's minutes are spent; or
  // no run of it at all.
  const api = createServer((request, response) => {
    const path = new URL(request.url!, 'http://api').pathname
    const ended = { id: 7, status: 'completed', conclusion: 'failure', html_url: 'https://run/7' }
    const body =
      path === '/repos/owner/ultimate/actions/runs'
        ? {
            workflow_runs: expected.underWay
              ? [{ ...ended, status: 'in_progress', conclusion: null }]
              : [],
          }
        : path === '/repos/owner/ultimate/actions/runs/7'
          ? ended
          : path === '/repos/owner/ultimate/actions/runs/7/jobs'
            ? {
                jobs: [
                  {
                    id: 2,
                    name: 'test (1/2)',
                    conclusion: 'failure',
                    started_at: '2026-01-01T00:00:00Z',
                    completed_at: '2026-01-01T00:00:00Z',
                  },
                ],
              }
            : path === '/repos/owner/ultimate/check-runs/2/annotations'
              ? [
                  {
                    path: '.github',
                    start_line: 1,
                    message:
                      "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
                    annotation_level: 'failure',
                  },
                ]
              : undefined
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body ?? { message: 'Not Found' }))
  })
  await new Promise<void>((done) => api.listen(0, '127.0.0.1', done))
  const gated = await runGate(
    root,
    checkout,
    bin,
    `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
  )
  api.close()
  const banner = /CI GATE FALLBACK: .*/.exec(gated.stdout)?.[0]
  expect(banner?.slice(0, expected.banner?.length)).toBe(expected.banner)
  expect(await calls()).toEqual(expected.calls)
  expect(gated.code).toBe(expected.code)
  expect(gated.last).toBe(expected.last(sha))
  expect(gated.stdout).not.toContain(TOKEN)
})

it('reuses a recent pass of the exact commit with its origin, without pushing, checking or testing again', async () => {
  const root = await temp('ultimate-ci-reuse-')
  const { bin, checkout, sha, calls } = await gateFixture(root)
  // No such host: a push would fail, so the gate can only pass by reusing.
  await git(checkout, 'remote', 'add', 'fork', 'https://github.com/owner/ultimate.git')
  await git(
    checkout,
    'config',
    `url.${join(root, 'nowhere')}/.pushInsteadOf`,
    'https://github.com/',
  )
  await git(checkout, 'config', 'credential.helper', `!f() { echo password=${TOKEN}; }; f`)
  const finished = Date.now() - 60_000
  const asked: string[] = []
  const api = createServer((request, response) => {
    const url = new URL(request.url!, 'http://api')
    asked.push(`${url.pathname}${url.search}`)
    const passed = { id: 7, status: 'completed', conclusion: 'success', html_url: 'https://run/7' }
    const body =
      url.pathname === '/repos/owner/ultimate/actions/runs'
        ? { workflow_runs: url.searchParams.get('head_sha') === sha ? [passed] : [] }
        : url.pathname === '/repos/owner/ultimate/actions/runs/7'
          ? passed
          : url.pathname === '/repos/owner/ultimate/actions/runs/7/jobs'
            ? {
                jobs: [
                  {
                    id: 2,
                    name: 'test (1/2)',
                    conclusion: 'success',
                    started_at: new Date(finished - 198_000).toISOString(),
                    completed_at: new Date(finished).toISOString(),
                  },
                ],
              }
            : undefined
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body ?? { message: 'Not Found' }))
  })
  await new Promise<void>((done) => api.listen(0, '127.0.0.1', done))
  const { code, stdout, last } = await runGate(
    root,
    checkout,
    bin,
    `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
  )
  api.close()
  expect(code).toBe(0)
  const line = stdout.split('\n').find((text) => text.startsWith('lander-reused: '))!
  expect(JSON.parse(line.slice('lander-reused: '.length))).toEqual({
    runner: 'GitHub Actions',
    url: 'https://run/7',
    sha,
    completedAt: new Date(new Date(finished).toISOString()).getTime(),
    seconds: 198,
  })
  // The pass covered the check and the audit too (CI's first shard): nothing runs here.
  expect(last).toBe(
    `ci-gate: reused: GitHub Actions passed check, audit, test and test:e2e for ${sha.slice(0, 7)} 1 min ago, https://run/7`,
  )
  expect(await calls()).toEqual([])
  expect(asked[0]).toBe(`/repos/owner/ultimate/actions/runs?head_sha=${sha}&event=push`)
  expect(stdout).not.toContain('pushed ci/')
})

it('asks the PC for the check and the suites after the audit here, and checks nothing else here', async () => {
  const root = await temp('ultimate-ci-gate-pc-')
  const { bin, checkout, sha, calls } = await gateFixture(root)
  await pcRunner(root, bin)
  // No fork remote: no earlier run is found and GitHub is never asked.
  await git(checkout, 'remote', 'add', 'pc', 'my-pc:ci.git')
  const { code, last } = await runGate(root, checkout, bin)
  expect(code).toBe(0)
  expect(await calls()).toEqual([
    'audit --audit-level high in checkout',
    ...['install --frozen-lockfile --prefer-offline', 'check', 'test', 'test:e2e'].map(
      (command) => `${command} in ${sha}`,
    ),
  ])
  expect(last).toMatch(
    new RegExp(
      `^ci-gate: ran fresh \\(.+\\): my-pc passed check, test and test:e2e for ${sha.slice(0, 7)} in \\d+ s; audit passed here$`,
    ),
  )
})

it('runs CI on the PC runner first and delivers its failing tests without GitHub', async () => {
  const root = await temp('ultimate-ci-pc-')
  const bin = join(root, 'bin')
  await mkdir(bin)
  const pcHome = await pcRunner(root, bin)
  process.env.PATH = `${bin}:${searchPath}`
  // A project whose `test` suite fails one test the way Vitest reports it; it has no fork remote, so GitHub is never used.
  const checkout = join(root, 'checkout')
  await mkdir(checkout)
  await git(checkout, 'init', '-q', '-b', 'main')
  await writeFile(
    join(checkout, 'package.json'),
    JSON.stringify({
      name: 'p',
      private: true,
      scripts: { check: 'echo checked', test: 'node t.mjs', 'test:e2e': 'echo e2e' },
    }),
  )
  await writeFile(
    join(checkout, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
  )
  await writeFile(
    join(checkout, 't.mjs'),
    "console.log(' FAIL  test/a.test.ts > adds > two')\nconsole.log('AssertionError: expected 3 to be 4')\nprocess.exit(1)\n",
  )
  await git(checkout, 'add', '.')
  await git(checkout, 'commit', '-qm', 'first')
  await git(checkout, 'remote', 'add', 'pc', 'my-pc:ci.git')
  const sha = await git(checkout, 'rev-parse', 'HEAD')

  const prepared = await prepareHarness({
    ultimateRoot: root,
    userHome: await temp(),
    home: join(root, 'home'),
    faux: fauxProvider(),
  })
  let opened: OpenHost
  prepared.registry.install(
    ciExtension({
      projectRoot: checkout,
      harness: () => opened.harness,
      need: (() => ({ get: async () => undefined, failing: async () => [], resultIn })) as never,
      onOpen: () => {},
      onClose: () => {},
    }),
  )
  prepared.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('ci', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Started.')]),
    fauxAssistantMessage([fauxText('Read the result.')]),
  ])
  opened = await prepared.open()
  hosts.push(opened)
  const caller = opened.root
  await caller.submit({ type: 'input', requestId: 'go', content: 'Run CI' }, context)

  const results = async () =>
    (await caller.context(context)).entries.filter((entry) => entry.kind === 'ci.result')
  await waitFor(async () => (await results()).length > 0, 45_000)
  const result = (await results())[0].data as CiResult
  expect(result).toMatchObject({
    sha,
    conclusion: 'failure',
    runner: 'my-pc',
    jobs: [
      { name: 'check', conclusion: 'success' },
      { name: 'test', conclusion: 'failure' },
    ],
    failures: [
      { title: 'test/a.test.ts > adds > two', message: 'AssertionError: expected 3 to be 4' },
    ],
  })
  expect(result.url).toBeUndefined()
  // The run's worktree and ref are gone from the PC.
  expect(await git(join(pcHome, 'ci.git'), 'for-each-ref')).toBe('')
  expect(JSON.stringify((await caller.context(context)).entries)).toContain(
    'FAIL test/a.test.ts > adds > two: AssertionError: expected 3 to be 4',
  )
})
