import { mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../../../server/harness.ts'
import { Metadata } from '../../../../server/metadata.ts'
import type { ActionContext } from '../../../../server/actions.ts'
import { actions } from '../../server.ts'
import { Workspaces } from '../../workspaces.ts'
import { git } from '../../../../lib/git.ts'
import { CheckRan } from '../../api.ts'
import lineage, { startBranch } from '../../../lineage/server.ts'
import { concludeIn } from '../../../conversations/server.ts'
import { seedTally, until } from '../../../../test/helpers.ts'
import { enterSlot, peekSlot, releaseSlot, thisProcess } from '../../../../lib/slot.ts'
import {
  repository,
  fixture,
  commit,
  submitted,
  landerLog,
  rootNotes,
  messageLog,
  lander,
} from './workspaces-integration-fixture.ts'

async function withRemote() {
  const paths = await repository()
  const bare = join(paths.directory, 'remote.git')
  await git(paths.directory, 'init', '-q', '--bare', '-b', 'main', bare)
  await git(paths.projectRoot, 'remote', 'add', 'origin', bare)
  await git(paths.projectRoot, 'push', '-q', 'origin', 'main')
  return { paths, bare }
}
/** Hold the lander's pushes from the project checkout with a pre-push hook until `release`. */
async function holdPush(f: Awaited<ReturnType<typeof fixture>>) {
  const started = join(f.directory, 'push-started')
  const gate = join(f.directory, 'push-gate')
  await writeFile(
    join(f.projectRoot, '.git/hooks/pre-push'),
    `#!/bin/sh\ncat >/dev/null\ntouch '${started}'\nwhile [ ! -f '${gate}' ]; do sleep 0.02; done\n`,
    { mode: 0o755 },
  )
  return {
    started: () =>
      until(() =>
        access(started).then(
          () => true,
          () => false,
        ),
      ),
    release: () => writeFile(gate, ''),
  }
}

/** A check that marks `started` and waits for `gate`; both files live in the test directory. */
function heldCheck(f: Awaited<ReturnType<typeof fixture>>, then = 'true') {
  const started = join(f.directory, 'check-started')
  const gate = join(f.directory, 'check-gate')
  return {
    command: `touch '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done; ${then}`,
    started: () =>
      until(() =>
        access(started).then(
          () => true,
          () => false,
        ),
      ),
    release: () => writeFile(gate, ''),
  }
}
it.concurrent('lands two submissions in order onto a moved target and reports both', async () => {
  const f = await lander({ checks: ['test -f base.txt'] })
  const first = await f.create()
  const second = await f.create()
  await f.service.ready(first, context)
  await f.service.ready(second, context)
  const one = (await f.service.get(first, context))!
  const two = (await f.service.get(second, context))!
  await commit(one.path, 'one.txt')
  await commit(two.path, 'two.txt')
  await commit(f.projectRoot, 'moved.txt')
  const submittedFirst = await f.call(first, 'workspace', { action: 'submit', divergence: 'None' })
  expect(JSON.stringify(submittedFirst)).toContain('position')
  await f.service.submit(second, 'None', context)
  const [reportOne] = await submitted(f, first)
  const [reportTwo] = await submitted(f, second)
  expect(reportOne).toContain('landed as')
  expect(reportOne).toContain('one.txt')
  expect(reportOne).toContain('Not pushed.')
  expect(reportTwo).toContain('two.txt')
  expect(await git(f.projectRoot, 'log', '--first-parent', '--format=%s', '-3')).toMatch(
    new RegExp(
      `^Merge .* from #${second} into main\nMerge .* from #${first} into main\nmoved.txt$`,
    ),
  )
  expect(
    await git(
      f.projectRoot,
      'log',
      '-1',
      '--format=%(trailers:key=Ultimate-Conversation,valueonly)',
    ),
  ).toBe(String(second))
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
  for (const name of ['one.txt', 'two.txt', 'moved.txt'])
    expect(await readFile(join(f.projectRoot, name), 'utf8')).toBe(name)
  const secondWorkspace = (await f.service.get(second, context))!
  expect('landed' in secondWorkspace ? secondWorkspace.landed : undefined).toBe(
    await git(f.projectRoot, 'rev-parse', 'HEAD'),
  )
  // Both submissions logged into one lander conversation, each ending with its landed outcome.
  const { id, metadata, cwd, kinds, log } = await landerLog(f)
  expect(metadata).toEqual({ title: '@lander', label: 'lander' })
  // The lander the submission created is standing at once: concluding it is refused.
  await expect(
    f.opened.harness.commit((tx) => concludeIn(f.host, tx, [id]), context),
  ).rejects.toThrow(`#${id} is a standing agent`)
  expect(cwd).toMatch(/\/lander\/[0-9a-f]{12}$/)
  expect(kinds.every((kind) => kind === 'ultimate.lander')).toBe(true)
  expect(reportOne).toContain(`lander conversation #${id}`)
  const [submissionOne, submissionTwo] = [...new Set(log.map((line) => line.submission))]
  expect(reportOne).toContain(`Submission ${submissionOne} (#${first}, `)
  expect(reportTwo).toContain(`Submission ${submissionTwo} (#${second}, `)
  const firstLog = log.filter((line) => line.submission === submissionOne)
  expect(firstLog.map((line) => line.step ?? line.outcome)).toEqual([
    'queued',
    'started',
    'preparing',
    'merging',
    'setting up',
    'checking: test -f base.txt',
    'checked: test -f base.txt',
    'fast-forwarding',
    'landed',
  ])
  expect(firstLog[5].runs).toBe('test -f base.txt')
  expect(firstLog[6].check).toEqual({ command: 'test -f base.txt', result: 'passed' })
  const landedOne = firstLog.at(-1)!
  expect(landedOne).toMatchObject({ conversationId: first, outcome: 'landed' })
  expect(landedOne.commits).toEqual([
    expect.stringContaining(`from #${first} into main`),
    expect.stringContaining('one.txt'),
  ])
  expect(landedOne.paths).toContain('one.txt')
  expect(landedOne.pushed).toBeUndefined()
  // Its checks ran: nothing warns that it is unchecked.
  expect(landedOne.unchecked).toBeUndefined()
  expect(reportOne).not.toContain('Unchecked')
  expect(log.filter((line) => line.submission === submissionTwo).at(-1)).toMatchObject({
    conversationId: second,
    outcome: 'landed',
    sha: await git(f.projectRoot, 'rev-parse', 'HEAD'),
  })
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  expect(index.results[submissionTwo]).toMatchObject({ outcome: 'landed' })
  // Lineage is disabled in this fixture: landings leave no root note.
  expect(await rootNotes(f)).toHaveLength(0)
})
it.concurrent('never runs the checks of a declined project setup and says the landing is unchecked', async () => {
  const f = await fixture()
  const ran = join(f.directory, 'ran')
  await mkdir(join(f.projectRoot, '.ultimate'))
  await writeFile(
    join(f.projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ lander: { checks: [`touch '${ran}'`, [`touch '${ran}'`, 'true']] } }),
  )
  // As the core with the folder's setup declined: its settings read as none.
  f.host.projectSetup = async () => ({ config: true, decision: false })
  f.host.projectSettings = async () => ({})
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(report).toContain('declares 3 lander checks, but none ran')
  await expect(access(ran)).rejects.toThrow('ENOENT')
  const { log } = await landerLog(f)
  expect(log.filter((line) => line.warning).map((line) => line.step)).toEqual([
    'skipped 3 declared checks: project setup declined',
  ])
  expect(log.at(-1)).toMatchObject({
    outcome: 'landed',
    unchecked: { reason: 'untrusted', declared: 3, decision: 'declined' },
  })
  // A project that declares no checks lands with a quiet note that none ran.
  await rm(join(f.projectRoot, '.ultimate'), { recursive: true })
  await commit((await f.service.get(id, context))!.path, 'again.txt')
  await f.service.submit(id, 'None', context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('Unchecked: no lander checks are configured')
  expect((await landerLog(f)).log.at(-1)).toMatchObject({
    outcome: 'landed',
    unchecked: { reason: 'none' },
  })
})
it.concurrent('runs a check group concurrently and records each summary', async () => {
  const f = await fixture()
  /** Both checks must start before either gate is released; serial execution cannot pass. */
  const meet = (name: string) =>
    `mkfifo '${join(f.directory, name)}.gate'; touch '${join(f.directory, name)}'; read release < '${join(f.directory, name)}.gate'; printf 'log\\n\\033[32m${name} met\\033[0m\\n\\n'`
  const group = [meet('one'), meet('two')]
  f.host.projectSettings = async () => ({ lander: { checks: ['true', group] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  await until(async () => {
    const started = await Promise.all(
      ['one', 'two'].map((name) =>
        access(join(f.directory, name)).then(
          () => true,
          () => false,
        ),
      ),
    )
    return started.every(Boolean)
  })
  await Promise.all(
    ['one', 'two'].map((name) => writeFile(join(f.directory, name) + '.gate', 'ready\n')),
  )
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(report).not.toContain('Flaky')
  const checks = (await landerLog(f)).log.flatMap((line) => (line.check ? [line.check] : []))
  expect(checks[0]).toEqual({ command: 'true', result: 'passed' })
  // ANSI stripped, trailing blank lines skipped.
  expect(checks.slice(1)).toEqual(
    expect.arrayContaining(
      ['one met', 'two met'].map((summary) =>
        expect.objectContaining({ result: 'passed', summary }),
      ),
    ),
  )
  expect(checks).toHaveLength(3)
})
it.concurrent('records a check that reused a named pass of the landed commit, with its origin', async () => {
  // The check claims a pass of the commit it runs on, from run 4297, as the CI gate prints one.
  const command = `printf '%s{"runner":"GitHub Actions","url":"https://ci.example/runs/4297","sha":"%s","completedAt":1794381000000,"seconds":198}\n' 'lander-reused: ' $(git rev-parse HEAD); echo reused it`
  const f = await lander({ checks: [command] })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  const sha = await git(f.projectRoot, 'rev-parse', 'HEAD')
  expect(report).toContain('landed as')
  // The report is the stored model message as JSON, so its quotes are escaped.
  expect(report).toContain(
    JSON.stringify(
      `Reused: ${command}: GitHub Actions passed ${sha.slice(0, 7)} in 198 s, finished 2026-11-11T07:10:00.000Z: https://ci.example/runs/4297`,
    ).slice(1, -1),
  )
  const reused = {
    runner: 'GitHub Actions',
    url: 'https://ci.example/runs/4297',
    sha,
    completedAt: 1794381000000,
    seconds: 198,
  }
  const log = (await landerLog(f)).log
  expect(log.findLast((line) => line.check)!.check).toEqual({
    command,
    result: 'reused',
    reused,
    summary: 'reused it',
  })
  expect(log.at(-1)).toMatchObject({ outcome: 'landed', reused: [{ command, ...reused }] })
})
it.concurrent('reruns only the failing command of a group, reports its output twice failed, and lands a flaky one', async () => {
  const f = await lander({
    checks: [['echo PASSING_SUMMARY', 'echo CHECK_OUTPUT_TAIL; test ! -f fail.txt']],
  })
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  await commit(workspace.path, 'fail.txt')
  await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  expect(report).toContain('check failed twice')
  expect(report).toContain('CHECK_OUTPUT_TAIL')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
  const failed = (await landerLog(f)).log
  expect(
    failed.filter((line) => line.step?.startsWith('rerunning:')).map((line) => line.step),
  ).toEqual(['rerunning: echo CHECK_OUTPUT_TAIL; test ! -f fail.txt'])
  expect(failed.filter((line) => line.check).map((line) => line.check)).toEqual(
    expect.arrayContaining([
      { command: 'echo PASSING_SUMMARY', result: 'passed', summary: 'PASSING_SUMMARY' },
      { command: 'echo CHECK_OUTPUT_TAIL; test ! -f fail.txt', result: 'failed' },
    ]),
  )
  expect(failed.at(-1)).toMatchObject({
    outcome: 'failed',
    reason: 'check failed twice: echo CHECK_OUTPUT_TAIL; test ! -f fail.txt',
    output: expect.stringContaining('CHECK_OUTPUT_TAIL'),
  })
  expect(failed.at(-1)!.sha).toBeUndefined()
  // A failed landing leaves no note in the root.
  expect(await rootNotes(f)).toHaveLength(0)
  const marker = join(f.directory, 'flaky')
  f.host.projectSettings = async () => ({
    lander: {
      checks: [
        [
          'true',
          `if [ -f '${marker}' ]; then echo ok; exit 0; fi; touch '${marker}'; echo FIRST_RUN_FAILED; exit 1`,
        ],
      ],
    },
  })
  await git(workspace.path, 'rm', '-q', 'fail.txt')
  await git(workspace.path, 'commit', '-qm', 'fix')
  await f.service.submit(id, 'None', context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('landed as')
  expect(reports.at(-1)).toContain('Flaky: if [')
  const flaky = (await landerLog(f)).log
  expect(flaky.findLast((line) => line.check)!.check).toMatchObject({
    result: 'flaky',
    summary: 'ok',
  })
  // The run that failed keeps its output in the log, so the flake can be diagnosed later.
  expect(flaky.findLast((line) => line.check?.result === 'failed')).toMatchObject({
    output: expect.stringContaining('FIRST_RUN_FAILED'),
  })
  expect(flaky.at(-1)).toMatchObject({
    outcome: 'landed',
    flaky: [expect.stringContaining('if [')],
  })
  // Every run is one event, reruns included: the failing submission's, then the flaky one's.
  const checks = await f.host.eventLog.recent({ events: [CheckRan], limit: 20 })
  const runs = (submission: string) =>
    checks
      .filter((event) => event.data.submission === submission)
      .map((event) => `${event.data.command.split(' ', 2).join(' ')} ${event.data.result}`)
      .toSorted()
  const submissions = [...new Set(checks.map((event) => event.data.submission))]
  expect(submissions).toHaveLength(2)
  expect(runs(submissions[1])).toEqual([
    'echo CHECK_OUTPUT_TAIL; failed',
    'echo CHECK_OUTPUT_TAIL; failed',
    'echo PASSING_SUMMARY passed',
  ])
  expect(runs(submissions[0])).toEqual(['if [ failed', 'if [ flaky', 'true passed'])
  for (const event of checks) expect(event.data.ms).toEqual(expect.any(Number))
})
it.concurrent("names the failed tests that also failed at other branches' landings, never the submitter's own", async () => {
  const f = await lander({
    checks: [
      "printf ' FAIL  test/a.test.ts > keeps failing\\n FAIL  test/b.test.ts > once\\n'; exit 1",
    ],
  })
  const branch = async (name: string) => {
    const id = await f.create()
    await f.service.ready(id, context)
    await commit((await f.service.get(id, context))!.path, name)
    await f.service.submit(id, 'None', context)
    return id
  }
  const first = await branch('first.txt')
  expect((await submitted(f, first))[0]).not.toContain('other branches')
  // Only test/a also fails for another branch: its report names that one and the first branch.
  f.host.projectSettings = async () => ({
    lander: { checks: ["printf ' FAIL  test/a.test.ts > keeps failing\\n'; exit 1"] },
  })
  const second = await branch('second.txt')
  const [report] = await submitted(f, second)
  expect(report).toContain(
    `Also failed at other branches' landings; check whether it is flaky before investigating from scratch:\\n- test/a.test.ts > keeps failing: 1 earlier landing (#${first})`,
  )
  expect((await landerLog(f)).log.at(-1)).toMatchObject({
    outcome: 'failed',
    repeats: [{ test: 'test/a.test.ts > keeps failing', landings: 1, branches: [first] }],
  })
  // The first branch submitting again counts the second's landing, not its own earlier one.
  await commit((await f.service.get(first, context))!.path, 'again.txt')
  await f.service.submit(first, 'None', context)
  const reports = await submitted(f, first)
  expect(reports.at(-1)).toContain(
    `- test/a.test.ts > keeps failing: 1 earlier landing (#${second})`,
  )
})
it.concurrent('fast-forwards the worktree that has the target checked out, past unrelated dirty files but not over overlapping ones', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  // The target lives in another worktree than the project checkout.
  await git(f.projectRoot, 'switch', '-q', '-c', 'other')
  const elsewhere = join(f.directory, 'elsewhere')
  await git(f.projectRoot, 'worktree', 'add', '-q', elsewhere, 'main')
  await writeFile(join(elsewhere, 'unrelated.txt'), 'dirty')
  const tip = await commit(workspace.path)
  await f.service.submit(id, 'None', context)
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await git(elsewhere, 'rev-parse', 'HEAD')).toBe(tip)
  expect(await readFile(join(elsewhere, 'change.txt'), 'utf8')).toBe('change.txt')
  expect(await readFile(join(elsewhere, 'unrelated.txt'), 'utf8')).toBe('dirty')
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
  await writeFile(join(elsewhere, 'overlap.txt'), 'dirty')
  await commit(workspace.path, 'overlap.txt')
  await f.service.submit(id, 'None', context)
  const reports = await submitted(f, id)
  expect(reports.at(-1)).toContain('refused the fast-forward')
  expect(reports.at(-1)).toContain('overlap.txt')
  expect(await git(elsewhere, 'rev-parse', 'HEAD')).toBe(tip)
})
it.concurrent('counts checkouts by state, commits and uncommitted changes, and measures their disk once a minute', async () => {
  const f = await fixture()
  const landed = await f.create()
  const ahead = await f.create()
  const dirty = await f.create()
  const removed = await f.create()
  for (const id of [landed, ahead, dirty, removed]) await f.service.ready(id, context)
  await commit((await f.service.get(landed, context))!.path)
  await f.service.land(landed, context)
  await commit((await f.service.get(ahead, context))!.path, 'ahead.txt')
  await writeFile(join((await f.service.get(dirty, context))!.path, 'dirty.txt'), 'dirty')
  await f.service.discard(removed, context)
  const stats = await actions.stats({}, { host: f.host } as ActionContext)
  expect(stats).toEqual({
    total: 4,
    ready: 3,
    preparing: 0,
    failed: 0,
    releasing: 0,
    removed: 1,
    landed: 1,
    ahead: 1,
    fresh: 1,
    dirty: 1,
  })
  const disk = await actions.disk({}, { host: f.host } as ActionContext)
  expect(disk.bytes).toBeGreaterThan(0)
  expect(await actions.disk({}, { host: f.host } as ActionContext)).toBe(disk)
  // Counting never removes anything.
  expect((await f.service.get(landed, context))!.state).toBe('ready')
})
it.concurrent('kills the whole process group of a running check when the lander is aborted', async () => {
  const f = await fixture()
  const pidFile = join(f.directory, 'child.pid')
  f.host.projectSettings = async () => ({
    // An indefinitely blocked child lets the test observe process-group cancellation, not elapsed time.
    lander: { checks: [`tail -f /dev/null & echo $! > '${pidFile}'; wait`] },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  await until(() =>
    readFile(pidFile, 'utf8').then(
      (text) => text.trim() !== '',
      () => false,
    ),
  )
  const pid = Number(await readFile(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).not.toThrow()
  const index = (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
  await f.opened.harness.abortTask(Object.values(index.landers)[0] as TaskId, context)
  await until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 5000)
})
// Not concurrent, like the next one: both hold the heavy-work queue this file's tests share.
it('waits in the heavy-work queue for its heavy checks and lets the slot go before the light ones', async () => {
  const f = await fixture()
  const ran = join(f.directory, 'heavy-ran')
  const light = heldCheck(f)
  // The name is all that makes it heavy; it runs outside the checkout, so the checkout stays clean.
  f.host.projectSettings = async () => ({
    lander: { checks: [`: pnpm check; touch '${ran}'`, light.command] },
  })
  const other = { id: 'other-job', at: 0, label: 'pnpm test', from: '#7 in my-app' }
  const start = { floor: undefined, need: 1536, start: thisProcess }
  expect(await enterSlot(other, start)).toMatchObject({ kind: 'started' })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  await until(async () =>
    (await landerLog(f)).log.some((row) =>
      row.step?.startsWith(
        'waiting: next in line for the heavy-work slot, behind `pnpm test` from #7 in my-app',
      ),
    ),
  )
  await expect(access(ran)).rejects.toThrow('ENOENT')
  await releaseSlot(other.id)
  await light.started()
  // The heavy check ran, and the light one runs with the slot free for the next job in line.
  await access(ran)
  expect(await peekSlot({ id: 'next-job', at: Date.now() })).toEqual({ kind: 'next' })
  await light.release()
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
})
it("queues a check's own heavy work in the machine's queue, not in the check's private TMPDIR", async () => {
  const f = await fixture()
  // What the CI gate's local fallback does: look at the queue from inside a check, as a plain bash command would.
  const script = join(f.directory, 'look.ts')
  await writeFile(
    script,
    `import { enterSlot, thisProcess } from '${resolve('lib/slot.ts')}'\n` +
      `const look = await enterSlot({ id: 'gate', at: Date.now(), label: 'pnpm test', from: 'the gate' }, { floor: undefined, need: 1536, start: thisProcess, queue: false })\n` +
      `process.exit(look.kind === 'waiting' ? 0 : 1)\n`,
  )
  f.host.projectSettings = async () => ({ lander: { checks: [`node '${script}'`] } })
  const other = { id: 'gate-other', at: 0, label: 'pnpm test', from: '#7 in my-app' }
  expect(
    await enterSlot(other, { floor: undefined, need: 1536, start: thisProcess }),
  ).toMatchObject({ kind: 'started' })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  try {
    // The check sees the job this test holds, so it passes.
    const [report] = await submitted(f, id)
    expect(report).toContain('landed as')
  } finally {
    await releaseSlot(other.id)
  }
})
it.concurrent('runs worktree setup on the merged revision before the checks', async () => {
  const f = await fixture()
  await writeFile(join(f.projectRoot, '.gitignore'), 'have.txt\n')
  await writeFile(join(f.projectRoot, 'want.txt'), 'one')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-qm', 'setup inputs')
  f.host.projectSettings = async () => ({
    isolates: { worktree: { setup: ['cp want.txt have.txt'] } },
    lander: { checks: ['cmp want.txt have.txt'] },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  // The check passes only when setup copies the merged want.txt, not the target's.
  await writeFile(join(workspace.path, 'want.txt'), 'two')
  await git(workspace.path, 'commit', '-qam', 'needs setup')
  await f.service.submit(id, 'None', context)
  const [report] = await submitted(f, id)
  expect(report).toContain('landed as')
  expect(report).not.toContain('Flaky')
})
it.concurrent('resumes a landing interrupted before its push: pushes and reports what it landed, not the moved target', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths, true)
  const id = await f.create()
  const other = await f.create()
  await f.service.ready(id, context)
  await f.service.ready(other, context)
  await commit((await f.service.get(id, context))!.path, 'landed.txt')
  const push = await holdPush(f)
  const { id: submission } = await f.service.submit(id, 'None', context)
  await push.started()
  // Fast-forwarded, push pending: the lander task ends here, as one faulted by a reload of its code does.
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  const landed = await git(f.projectRoot, 'rev-parse', 'main')
  expect((await index())!.queue[0].landed).toMatchObject({
    sha: landed,
    commits: [expect.stringContaining('landed.txt')],
  })
  const first = Object.values((await index())!.landers)[0] as TaskId
  await f.opened.harness.abortTask(first, context)
  await until(
    async () =>
      (await f.opened.harness.commit((tx) => tx.task(first), context))!.state.status === 'terminal',
  )
  await push.release()
  expect(await git(bare, 'rev-parse', 'main')).not.toBe(landed)
  expect((await index())!.queue).toMatchObject([{ id: submission, state: 'queued' }])
  // The target advances past the landing before its push.
  const later = (await f.service.get(other, context))!.path
  await git(later, 'merge', '-q', landed)
  await commit(later, 'later.txt')
  expect((await f.service.land(other, context)).landed).not.toBe(landed)
  // Opening starts a lander for the queue left behind, without a new submit.
  await f.reopen()
  const [report] = await submitted(f, id)
  expect(report).toContain(`landed as ${landed.slice(0, 7)} on main.`)
  expect(report).toContain('landed.txt')
  expect(report).toContain('Pushed to origin/main.')
  expect(report).not.toContain('nothing new')
  expect(await git(bare, 'rev-parse', 'main')).toBe(landed)
  const result = (await index())!.results[submission]
  expect(result).toMatchObject({ outcome: 'landed', sha: landed, pushed: 'origin/main' })
  // The resumed task merged and checked nothing again: it pushed what had landed.
  const steps = result.steps.map((row) => row.step)
  expect(steps.slice(steps.lastIndexOf('started'))).toEqual(['started', 'pushing to origin'])
  expect(await messageLog(f)).toEqual([])
})
it.concurrent('reports a local landing whose push retry conflicts as landed locally', async () => {
  const { paths, bare } = await withRemote()
  const f = await lander({ push: 'origin' }, paths)
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'base.txt'), 'workspace')
  const tip = await commit(workspace.path)
  const push = await holdPush(f)
  await f.service.submit(id, 'None', context)
  await push.started()
  // The remote moves with a conflicting change while the lander pushes.
  const other = join(f.directory, 'other')
  await git(f.directory, 'clone', '-q', bare, other)
  await writeFile(join(other, 'base.txt'), 'remote')
  await git(other, '-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qam', 'remote')
  await git(other, 'push', '-q', 'origin', 'main')
  await push.release()
  const [report] = await submitted(f, id)
  const landed = await git(f.projectRoot, 'rev-parse', 'main')
  expect(report).toContain(`landed locally as ${landed.slice(0, 7)} on main.`)
  expect(report).toContain('Push failed: origin/main conflicts with local main in:')
  expect(report).not.toContain('was not landed')
  expect(
    await git(f.projectRoot, 'merge-base', '--is-ancestor', tip, landed).then(() => true),
  ).toBe(true)
  const landedWorkspace = (await f.service.get(id, context))!
  expect('landed' in landedWorkspace ? landedWorkspace.landed : undefined).toBe(landed)
})
it.concurrent('resumes checks after a restart without rerunning passed ones and keeps flaky notes', async () => {
  const f = await fixture()
  const log = join(f.directory, 'runs')
  const marker = join(f.directory, 'failed-once')
  const gate = join(f.directory, 'rerun-gate')
  f.host.projectSettings = async () => ({
    lander: {
      checks: [
        `echo first >> '${log}'`,
        `echo second >> '${log}'; if [ ! -f '${marker}' ]; then touch '${marker}'; exit 1; fi; while [ ! -f '${gate}' ]; do sleep 0.05; done`,
      ],
    },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  await f.service.submit(id, 'None', context)
  const runs = () => readFile(log, 'utf8').catch(() => '')
  await until(async () => (await runs()) === 'first\nsecond\nsecond\n')
  const merged = await git(
    join(f.home, 'lander', (await readdir(join(f.home, 'lander')))[0]),
    'rev-parse',
    'HEAD',
  )
  await f.reopen()
  await writeFile(gate, '')
  const [report] = await submitted(f, id)
  expect(await runs()).toBe('first\nsecond\nsecond\nsecond\n')
  expect(report).toContain('landed as')
  expect(report).toContain(`Flaky: echo second`)
  expect(await git(f.projectRoot, 'rev-parse', 'main')).toBe(merged)
})
it.concurrent('starts a lander for queued submissions left by a lander task that ended', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'left.txt')
  // A held check keeps the first task landing; then it ends without draining its queue.
  const gate = join(f.directory, 'gate')
  f.host.projectSettings = async () => ({
    lander: { checks: [`while [ ! -f '${gate}' ]; do sleep 0.05; done`] },
  })
  await f.service.submit(id, 'None', context)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  await until(async () => (await index())!.queue[0]?.state === 'landing')
  const first = Object.values((await index())!.landers)[0] as TaskId
  await f.opened.harness.abortTask(first, context)
  await until(
    async () =>
      (await f.opened.harness.commit((tx) => tx.task(first), context))!.state.status === 'terminal',
  )
  expect((await index())!.queue).toMatchObject([{ state: 'queued' }])
  await writeFile(gate, '')
  await f.reopen()
  const second = Object.values((await index())!.landers)[0]
  expect(second).not.toBe(first)
  expect((await submitted(f, id))[0]).toContain('landed as')
  expect(await readFile(join(f.projectRoot, 'left.txt'), 'utf8')).toBe('left.txt')
  // Opening again with nothing queued starts nothing.
  await f.reopen()
  expect((await index())!.landers).toEqual({})
})

it.concurrent('starts an isolated branch of a tally whose first request sees its ready checkout', async () => {
  const f = await fixture()
  // Its prompt task delivers the first input.
  f.prepared.registry.install(lineage(f.host))
  await seedTally(f.opened.harness)
  const { id } = await startBranch(
    f.host,
    { from: ROOT_CONVERSATION_ID, prompt: 'ASK where am I?', isolated: true },
    context,
  )
  // The root is a tally that never runs, so it gets no checkout; its branch does.
  const conversation = (await f.opened.harness.conversation(id, context))!
  await until(async () => f.asked.length > 0)
  await conversation.waitForIdle(context)
  const workspace = (await f.service.get(id, context))!
  expect(workspace.state).toBe('ready')
  expect((await conversation.agent(context)).cwd).toBe(workspace.path)
  const [request] = f.asked
  expect(JSON.stringify(request.messages)).toContain(`Workspace: ${workspace.path}`)
  expect(await f.service.get(ROOT_CONVERSATION_ID, context)).toBeUndefined()
})

it.concurrent('refuses input to the model-free lander conversation', async () => {
  const f = await lander({})
  const { id } = await landerLog(f)
  const conversation = (await f.opened.harness.conversation(id, context))!
  await expect(
    conversation.submit({ type: 'input', content: 'What landed?' }, context),
  ).rejects.toThrow('The lander runs no model; its conversation is the landing log')
})
it.concurrent('gives the standing lander a checkout at the target tip before any submission', async () => {
  const f = await lander({})
  const { id, cwd } = await landerLog(f)
  expect(cwd).toMatch(/\/lander\/[0-9a-f]{12}$/)
  expect(await git(cwd!, 'rev-parse', 'HEAD')).toBe(await git(f.projectRoot, 'rev-parse', 'HEAD'))
  // Opening again keeps the checkout and updates an existing lander's old title.
  await writeFile(join(cwd!, 'kept.txt'), 'kept')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).title = 'Lander · main'
  }, context)
  await f.reopen()
  expect(await readFile(join(cwd!, 'kept.txt'), 'utf8')).toBe('kept')
  expect((await landerLog(f)).metadata).toEqual({ title: '@lander', label: 'lander' })
})

it.concurrent('lands only the commit every check ran on, never one added to its checkout meanwhile', async () => {
  const f = await fixture()
  const held = heldCheck(f)
  f.host.projectSettings = async () => ({ lander: { checks: [held.command] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path, 'submitted.txt')
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  await f.service.submit(id, 'None', context)
  await held.started()
  // As a tool call started before the landing would: no hook stops it.
  await commit(join(f.home, 'lander', (await readdir(join(f.home, 'lander')))[0]), 'sneaked.txt')
  await held.release()
  const [report] = await submitted(f, id)
  expect(report).toContain('was not landed: the integration checkout changed during checks')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
})

it.concurrent('resumes a group after a restart without a third run of its twice-failed member', async () => {
  const f = await fixture()
  const runs = join(f.directory, 'runs')
  const held = heldCheck(f)
  const failing = `echo failing >> '${runs}'; echo FAILING_OUTPUT; exit 1`
  f.host.projectSettings = async () => ({ lander: { checks: [[failing, held.command]] } })
  const id = await f.create()
  await f.service.ready(id, context)
  await commit((await f.service.get(id, context))!.path)
  const head = await git(f.projectRoot, 'rev-parse', 'HEAD')
  const { id: submission } = await f.service.submit(id, 'None', context)
  const index = () => f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context)
  const task = Object.values((await index())!.landers)[0] as TaskId
  // The failing member's rerun outcome is stored while its sibling still runs.
  await until(async () => {
    const record = await f.opened.harness.commit((tx) => tx.task(task), context)
    return record?.memos?.[`check:${submission}:1:0.0:rerun`] !== undefined
  })
  await held.started()
  await f.reopen()
  await held.release()
  const [report] = await submitted(f, id)
  expect(await readFile(runs, 'utf8')).toBe('failing\nfailing\n')
  expect(report).toContain(`was not landed: check failed twice: ${failing}`)
  expect(report).toContain('FAILING_OUTPUT')
  expect((await index())!.results[submission]).toMatchObject({
    outcome: 'failed',
    output: expect.stringContaining('FAILING_OUTPUT'),
  })
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(head)
})
