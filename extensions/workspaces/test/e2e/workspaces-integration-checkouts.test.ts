import { mkdir, readdir, readFile, writeFile, access, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context } from '../../../../server/harness.ts'
import type { ActionContext } from '../../../../server/actions.ts'
import { actions, order as workspacesOrder } from '../../server.ts'
import { Workspaces } from '../../workspaces.ts'
import { git } from '../../../../lib/git.ts'
import { setup } from '../../setup.ts'
import { landerCheckout, landerPath } from '../../lander.ts'
import promptExtension, { order as promptOrder } from '../../../prompt/server.ts'
import { Subagents } from '../../../subagents/api.ts'
import { temp, until } from '../../../../test/helpers.ts'
import { repository, fixture, commit, holdGit, lander } from './workspaces-integration-fixture.ts'

it.concurrent('serializes concurrent lander checkout creation', async () => {
  const { home, projectRoot } = await repository()
  const path = await landerPath(home, projectRoot, {})
  // Recover an unregistered directory left by an interrupted creation, too.
  await mkdir(path)
  await writeFile(join(path, 'incomplete'), 'interrupted')
  const results = await Promise.allSettled([
    landerCheckout(home, projectRoot, {}),
    landerCheckout(home, projectRoot, {}),
  ])
  expect(results).toEqual([
    { status: 'fulfilled', value: path },
    { status: 'fulfilled', value: path },
  ])
  const entries = (await git(projectRoot, 'worktree', 'list', '--porcelain')).split('\n\n')
  expect(entries.filter((entry) => entry.split('\n').includes(`worktree ${path}`))).toHaveLength(1)
  expect(await readFile(join(path, 'base.txt'), 'utf8')).toBe('base')
  expect(await readdir(path)).not.toContain('incomplete')
  // An existing checkout must be left alone, even when another tip is requested.
  await writeFile(join(path, 'keep.txt'), 'keep')
  expect(await landerCheckout(home, projectRoot, {}, 'missing-tip')).toBe(path)
  expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('keep')
})
it.concurrent('retries lander checkout creation after a failure', async () => {
  const { home, projectRoot } = await repository()
  await expect(landerCheckout(home, projectRoot, {}, 'missing-tip')).rejects.toThrow('missing-tip')
  expect(await landerCheckout(home, projectRoot, {})).toBe(await landerPath(home, projectRoot, {}))
})
it.concurrent('creates through the action; setup receives ULTIMATE_SOURCE and the first model request waits for ready', async () => {
  const f = await fixture()
  const sourceFile = join(f.directory, 'source-env')
  const gate = join(f.directory, 'setup-gate')
  f.host.projectSettings = async () => ({
    isolates: {
      worktree: {
        setup: [
          `mkfifo '${gate}'; echo "$ULTIMATE_SOURCE" > '${sourceFile}'; read release < '${gate}'`,
        ],
      },
    },
  })
  let seen = ''
  f.prepared.faux!.setResponses([
    async () => {
      seen = (await f.service.get(id, context))!.state
      return fauxAssistantMessage('ready')
    },
  ])
  const id = await f.create()
  const pending = (await f.service.get(id, context))!
  expect(pending.state).toBe('preparing')
  expect(pending.path).toBe(join(f.home, 'worktrees', String(id)))
  const conversation = (await f.opened.harness.conversation(id, context))!
  expect((await conversation.agent(context)).cwd).toBe(pending.path)
  const input = await conversation.submit({ type: 'input', content: 'go' }, context)
  await until(() =>
    access(sourceFile).then(
      () => true,
      () => false,
    ),
  )
  expect(seen).toBe('')
  await writeFile(gate, 'ready\n')
  await input.wait(context)
  expect(seen).toBe('ready')
  expect((await readFile(sourceFile, 'utf8')).trim()).toBe(f.projectRoot)
  expect(await git(pending.path, 'branch', '--show-current')).toBe(pending.branch)
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
})
it.concurrent('creates and removes checkouts where isolates.worktree.path says, through its add and remove commands', async () => {
  const f = await fixture()
  const log = join(f.directory, 'tree commands')
  f.host.projectSettings = async () => ({
    isolates: {
      worktree: {
        // A folder with a space: the commands get {name} and {path} as single shell words.
        path: join(f.directory, 'my trees', '{name}', 'src'),
        add: `echo add {name} >> '${log}' && git worktree add --detach {path} HEAD`,
        remove: `echo remove {name} >> '${log}' && git worktree remove {path}`,
      },
    },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const name = `ult-${workspace.branch.slice('ultimate/'.length)}`
  expect(workspace.path).toBe(join(await realpath(f.directory), 'my trees', name, 'src'))
  expect(await git(workspace.path, 'branch', '--show-current')).toBe(workspace.branch)
  await f.service.discard(id, context)
  expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path)
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
    `add ${name}`,
    `remove ${name}`,
  ])
})
it.concurrent('fails preparation when the configured add command leaves no worktree at the path', async () => {
  const f = await fixture()
  f.host.projectSettings = async () => ({
    isolates: { worktree: { path: join(f.directory, 'trees', '{name}'), add: 'true' } },
  })
  const id = await f.create()
  await f.service.ready(id, context)
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('isolates.worktree.add left no worktree'),
  })
})
it.concurrent('opens a conversation started in a subfolder of the repository in that subfolder of its checkout', async () => {
  const f = await fixture()
  await mkdir(join(f.projectRoot, 'app'))
  await writeFile(join(f.projectRoot, 'app/package.json'), '{}')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-m', 'app')
  const { id } = await actions.create({ cwd: join(f.projectRoot, 'app') }, {
    host: f.host,
  } as ActionContext)
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const conversation = (await f.opened.harness.conversation(id, context))!
  expect((await conversation.agent(context)).cwd).toBe(join(workspace.path, 'app'))
})
it.concurrent('renders workspace preparation before project context in the first composed provider request', async () => {
  const paths = await repository()
  const marker = 'CHECKOUT_RULE_ULT_123: preserve the release manifest.'
  await writeFile(join(paths.projectRoot, 'AGENTS.md'), marker)
  await git(paths.projectRoot, 'add', 'AGENTS.md')
  await git(paths.projectRoot, 'commit', '-m', 'checkout instructions')
  const f = await fixture([], paths)
  f.host.build = () =>
    ({ id: 'test-build', generation: 1, core: 'core', extensions: {}, changed: [] }) as never
  // As the server orders them: the workspace section waits for preparation before project context renders.
  f.prepared.extensionOrders.set('workspaces', workspacesOrder)
  f.prepared.extensionOrders.set('prompt', promptOrder)
  f.prepared.registry.install(promptExtension(f.host))
  const requests: string[] = []
  f.prepared.faux!.setResponses([
    (transcript) => {
      requests.push(
        JSON.stringify(transcript.messages.filter((message) => message.role === 'system')),
      )
      return fauxAssistantMessage('instructions read')
    },
  ])
  const worktree = await holdGit(f.projectRoot, 'worktree')
  const id = await f.create()
  const workspace = (await f.service.get(id, context))!
  await worktree.started()
  await expect(access(join(workspace.path, 'AGENTS.md'))).rejects.toThrow('ENOENT')
  const conversation = (await f.opened.harness.conversation(id, context))!
  const submission = await conversation.submit(
    { type: 'input', content: 'Read the checkout rules.' },
    context,
  )
  expect((await f.service.get(id, context))!.state).toBe('preparing')
  await worktree.release()
  await submission.wait(context)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain(marker)
  expect(await readFile(join(workspace.path, 'AGENTS.md'), 'utf8')).toBe(marker)
})
it.concurrent('setup closes stdin so commands waiting for EOF finish', async () => {
  const paths = await repository()
  await setup(
    paths.projectRoot,
    paths.projectRoot,
    {
      isolates: { worktree: { setup: ['cat >/dev/null; echo eof > eof.txt'] } },
    },
    AbortSignal.timeout(2000),
  )
  expect(await readFile(join(paths.projectRoot, 'eof.txt'), 'utf8')).toBe('eof\n')
})
it.concurrent('failed setup keeps its output tail, removes its empty branch, and blocks tools rather than writing in the source', async () => {
  const f = await fixture(['echo SETUP_OUTPUT_TAIL >&2; exit 1'])
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  expect(workspace.state).toBe('failed')
  expect('error' in workspace && workspace.error).toContain('SETUP_OUTPUT_TAIL')
  expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toBe('')
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Workspace setup failed:')
  expect(JSON.stringify(result)).toContain('call a tool again to retry the setup')
  expect(f.writes).toBe(0)
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
})
it.concurrent('retries a failed setup on the next tool call, so a fixed environment takes effect without a new conversation', async () => {
  // The setup fails until the environment is fixed, as a unit PATH without pnpm did.
  const f = await fixture(['test -f "$ULTIMATE_SOURCE/fixed" || { echo NOT_FIXED >&2; exit 1; }'])
  const id = await f.create()
  await f.service.ready(id, context)
  expect((await f.service.get(id, context))!.state).toBe('failed')
  const failed = await f.call(id, 'write_commit')
  expect(JSON.stringify(failed)).toContain('NOT_FIXED')
  expect(f.writes).toBe(0)

  await writeFile(join(f.projectRoot, 'fixed'), '')
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(false)
  const workspace = (await f.service.get(id, context))!
  expect(workspace.state).toBe('ready')
  expect('error' in workspace ? workspace.error : undefined).toBeUndefined()
  expect(f.writes).toBe(1)
  expect(await readFile(join(workspace.path, 'change.txt'), 'utf8')).toBe('change')
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
})
it.concurrent('runs shared-only until a fresh repository has its first commit, then stands its lander without a reopen', async () => {
  const directory = await temp('ultimate-workspaces-fresh-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const f = await fixture([], { directory, projectRoot, home: join(directory, 'state') })
  const isolation = () => actions.isolation({}, { host: f.host } as ActionContext)
  const landers = async () =>
    Object.keys(
      (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        .landerConversations,
    )
  expect(await isolation()).toEqual({ reason: 'Isolation needs a Git repository', empty: true })
  await git(projectRoot, 'init', '-b', 'main')
  await f.reopen()
  expect(await isolation()).toEqual({ reason: 'Isolation needs a first commit', empty: true })
  await writeFile(join(projectRoot, 'README.md'), 'app\n')
  expect(await isolation()).toEqual({ reason: 'Isolation needs a first commit', empty: false })
  await expect(actions.setupGit({}, { host: f.host } as ActionContext)).rejects.toThrow(
    'This folder has files',
  )
  await expect(f.create()).rejects.toThrow('Isolation needs a first commit')
  expect(await landers()).toEqual([])
  await git(projectRoot, 'config', 'user.email', 'test@example.com')
  await git(projectRoot, 'config', 'user.name', 'Test')
  await commit(projectRoot)
  expect(await Promise.all([isolation(), isolation()])).toEqual([{}, {}])
  expect(await landers()).toEqual([await realpath(projectRoot)])
  await f.service.ready(await f.create(), context)
})
it.concurrent('sets up Git in an empty folder with a first commit and its lander', async () => {
  const directory = await temp('ultimate-workspaces-empty-')
  const projectRoot = join(directory, 'project')
  await mkdir(projectRoot)
  const f = await fixture([], { directory, projectRoot, home: join(directory, 'state') })
  await actions.setupGit({}, { host: f.host } as ActionContext)
  expect(await git(projectRoot, 'log', '--format=%s')).toBe('Initial commit')
  expect(await actions.isolation({}, { host: f.host } as ActionContext)).toEqual({})
  expect(
    Object.keys(
      (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        .landerConversations,
    ),
  ).toEqual([await realpath(projectRoot)])
  await f.service.ready(await f.create(), context)
})
it.concurrent('rejects a detached source and preserves existing paths and branches instead of adopting them', async () => {
  const f = await fixture()
  await git(f.projectRoot, 'switch', '--detach')
  await expect(f.create()).rejects.toThrow('Isolation needs a checked-out branch')
  await git(f.projectRoot, 'switch', 'main')
  for (const existing of ['path', 'branch'] as const) {
    const id = await f.opened.harness.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      const workspace = await f.service.create(tx, child.id, f.projectRoot)
      if (existing === 'path') {
        await git(
          f.projectRoot,
          'worktree',
          'add',
          '-b',
          workspace.branch,
          workspace.path,
          workspace.base,
        )
        await writeFile(join(workspace.path, 'keep.txt'), 'keep')
      } else await git(f.projectRoot, 'branch', workspace.branch, workspace.base)
      return child.id
    }, context)
    await f.service.ready(id, context)
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('failed')
    expect('error' in workspace && workspace.error).toContain(
      `Workspace ${existing} already exists`,
    )
    expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(workspace.base)
    expect(await readFile(join(workspace.path, 'keep.txt'), 'utf8').catch(() => undefined)).toBe(
      existing === 'path' ? 'keep' : undefined,
    )
  }
})

it.concurrent('queued landing reads the current record after another workspace lands', async () => {
  const f = await fixture()
  const first = await f.create()
  const second = await f.create()
  await f.service.ready(first, context)
  await f.service.ready(second, context)
  await commit((await f.service.get(first, context))!.path)
  const merge = await holdGit(f.projectRoot, 'merge')
  const landing = f.service.land(first, context)
  await merge.started()
  const queued = f.service.land(second, context).catch((error: Error) => error)
  try {
    await actions.discard({ id: second }, { host: f.host } as ActionContext)
  } finally {
    await merge.release()
  }
  await landing
  expect(await queued).toMatchObject({ message: 'Workspace is removed' })
})
it.concurrent('requires nonempty divergence for submit before queuing anything', async () => {
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  for (const args of [{ action: 'submit' }, { action: 'submit', divergence: '   ' }]) {
    const result = await f.call(id, 'workspace', args)
    expect(JSON.stringify(result)).toContain('Submitting requires divergence')
  }
  expect(
    (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue,
  ).toHaveLength(0)
})

it.concurrent('submit on a detached HEAD names the commit and how to get back onto the branch', async () => {
  // A coordinator committed on a detached HEAD; submit used to fail with git's raw symbolic-ref error.
  const f = await lander({})
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await git(workspace.path, 'checkout', '-q', '--detach')
  const tip = await commit(workspace.path)
  const result = await f.call(id, 'workspace', { action: 'submit', divergence: 'None' })
  expect(JSON.stringify(result)).toContain(
    `Workspace HEAD is detached at ${tip.slice(0, 7)}, which contains ${workspace.branch}; run \`git checkout -B ${workspace.branch}\``,
  )
  expect(
    (await f.opened.harness.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue,
  ).toHaveLength(0)
})

it.concurrent('refuses dirty workspaces, overlapping dirty targets, changed branches and diverged targets', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'change.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('Worktree is dirty')
  await git(workspace.path, 'add', '.')
  await git(workspace.path, 'commit', '-m', 'change')
  await writeFile(join(f.projectRoot, 'change.txt'), 'dirty')
  await expect(f.service.land(id, context)).rejects.toThrow('change.txt')
  await writeFile(join(f.projectRoot, 'source.txt'), 'dirty')
  await git(f.projectRoot, 'add', '.')
  await git(f.projectRoot, 'commit', '-m', 'source')
  await expect(f.service.land(id, context)).rejects.toThrow(
    'update the workspace onto main and verify again',
  )
  await git(f.projectRoot, 'switch', '-c', 'changed')
  await expect(f.service.land(id, context)).rejects.toThrow('Target branch changed')
})

it.concurrent('discard refuses dirty, keeps the branch until reuse, and recreates before tools', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'change.txt'), 'dirty')
  await expect(f.service.discard(id, context)).rejects.toThrow('modified or untracked')
  const tip = await commit(workspace.path)
  await actions.discard({ id }, { host: f.host } as ActionContext)
  expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(tip)
  const result = await f.call(id, 'bash', { command: 'git rev-parse HEAD' })
  expect(JSON.stringify(result)).toContain(tip)
  expect(f.writes).toBe(0)
  expect((await f.service.get(id, context))!).toMatchObject({ state: 'ready', base: tip })
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
})
// Serial, like every test below that reads a mock's call history: Vitest clears all mocks before each test, so a
// concurrent sibling starting mid-flight would erase the calls this one is about to assert on.
it('isolated restart refuses before landing and accepts a clean running clone at the landed tip', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  expect(JSON.stringify(await f.call(id, 'restart'))).toContain('land your workspace into')
  expect(f.restart).not.toHaveBeenCalled()
  const workspace = (await f.service.get(id, context))!
  await commit(workspace.path)
  await f.service.land(id, context)
  expect(JSON.stringify(await f.call(id, 'restart'))).toContain('RESTART_CALLED')
  expect(f.restart).toHaveBeenCalledOnce()
  await writeFile(join(f.projectRoot, 'dirty.txt'), 'dirty')
  expect(JSON.stringify(await f.call(id, 'restart'))).toContain('land your workspace into')
  expect(f.restart).toHaveBeenCalledOnce()
})
it.concurrent('starts a worker isolate, commits in the child and lands it through the parent tool', async () => {
  const f = await fixture()
  const result = await f.call(f.opened.root.id, 'subagent', {
    action: 'start',
    agent: 'worker',
    task: 'CALL {"tool":"write_commit","args":{}}',
    isolate: 'worktree',
  })
  expect(JSON.stringify(result)).toContain('committed')
  const child = Object.values(
    (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.agents,
  )[0]
  const workspace = (await f.service.get(child.conversationId, context))!
  expect(workspace.state).toBe('ready')
  await expect(access(join(f.projectRoot, 'change.txt'))).rejects.toThrow('ENOENT')
  const landed = await f.call(f.opened.root.id, 'subagent', {
    action: 'land',
    id: child.conversationId,
  })
  expect(JSON.stringify(landed)).toContain('Landed commits')
  expect(await readFile(join(f.projectRoot, 'change.txt'), 'utf8')).toBe('change')
  expect(await git(f.projectRoot, 'rev-parse', 'HEAD')).toBe(
    await git(workspace.path, 'rev-parse', 'HEAD'),
  )
})
it.concurrent('stop lists what a worker left uncommitted and keeps it', async () => {
  const f = await fixture()
  await f.call(f.opened.root.id, 'subagent', {
    action: 'start',
    agent: 'worker',
    task: 'finish',
    isolate: 'worktree',
  })
  const child = Object.values(
    (await f.opened.harness.snapshot(Subagents, f.opened.root.id, context))!.agents,
  )[0].conversationId
  const workspace = (await f.service.get(child, context))!
  const stopped = async () =>
    JSON.stringify(await f.call(f.opened.root.id, 'subagent', { action: 'stop', id: child }))
  expect(await stopped()).toContain(`Stopped ${child}."`)
  await writeFile(join(workspace.path, 'draft.txt'), 'draft')
  // An unstaged edit of a tracked file: porcelain starts its line with a space (' M base.txt').
  await writeFile(join(workspace.path, 'base.txt'), 'edited')
  expect(await stopped()).toContain(
    `Stopped ${child}.\\nLeft uncommitted in ${workspace.path}: base.txt, draft.txt`,
  )
  // A staged change whose working copy was restored, and a name that starts with a space.
  await git(workspace.path, 'checkout', '--', 'base.txt')
  await writeFile(join(workspace.path, 'staged.txt'), 'staged')
  await git(workspace.path, 'add', 'staged.txt')
  await unlink(join(workspace.path, 'staged.txt'))
  await writeFile(join(workspace.path, ' lead.txt'), 'lead')
  await git(workspace.path, 'add', ' lead.txt')
  expect(await stopped()).toContain(
    `Stopped ${child}.\\nLeft uncommitted in ${workspace.path}:  lead.txt, staged.txt, draft.txt`,
  )
  expect(await readFile(join(workspace.path, 'draft.txt'), 'utf8')).toBe('draft')
})
