import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
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
import { temp, until as waitFor } from '../helpers.ts'

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) =>
  run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
// Moves the poll's sleeps along while the shared helper measures real IO against a real deadline.
const until = (test: () => boolean | Promise<boolean>) =>
  waitFor(test, 20_000, () => vi.advanceTimersByTimeAsync(5_000))

const TOKEN = 'stored-fork-token-1234'
const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  vi.useRealTimers()
  delete process.env.CI_GATE_API
})

it('runs CI on the fork in the background and wakes the caller once with the failing tests', async () => {
  const root = await temp('ultimate-ci-')
  // GitHub's git side: pushes to the fork's URL go to a local bare repository.
  const github = join(root, 'github')
  await mkdir(join(github, 'owner'), { recursive: true })
  await git(root, 'init', '-q', '--bare', join(github, 'owner/ultimate.git'))
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

  // GitHub's API side: a run exists once a ci/ ref was pushed, and it failed with an annotated failing test.
  const seen: { path: string; authorization?: string }[] = []
  const api = createServer((request, response) => {
    seen.push({ path: request.url!, authorization: request.headers.authorization })
    const path = new URL(request.url!, 'http://api').pathname
    const pushed =
      execFileSync('git', ['ls-remote', join(github, 'owner/ultimate.git'), 'refs/heads/ci/*'], {
        encoding: 'utf8',
      }) !== ''
    const body =
      path === '/repos/owner/ultimate/actions/runs'
        ? {
            workflow_runs: pushed
              ? [{ id: 7, status: 'completed', conclusion: 'failure', html_url: 'https://run/7' }]
              : [],
          }
        : path === '/repos/owner/ultimate/actions/runs/7'
          ? { id: 7, status: 'completed', conclusion: 'failure', html_url: 'https://run/7' }
          : path === '/repos/owner/ultimate/actions/runs/7/jobs'
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
      need: (() => ({ get: async () => undefined })) as never,
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
    failures: [{ title: 'test/a.test.ts > adds', message: 'AssertionError: expected 1 to be 2' }],
  })
  // The run's ref is deleted once the run ended.
  expect(
    await git(checkout, 'ls-remote', join(github, 'owner/ultimate.git'), 'refs/heads/ci/*'),
  ).toBe('')
  // The stored credential authenticates every API call and appears nowhere else.
  expect(seen.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
  const transcript = JSON.stringify((await caller.context(context)).entries)
  expect(transcript).not.toContain(TOKEN)
  expect(transcript).toContain('FAIL test/a.test.ts > adds: AssertionError: expected 1 to be 2')
  api.close()
})
