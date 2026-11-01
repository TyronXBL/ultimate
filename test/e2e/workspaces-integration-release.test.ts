import { mkdir, readFile, writeFile, access, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { context } from '../../server/harness.ts'
import { UiState } from '../../server/ui-state.ts'
import type { ActionContext } from '../../server/actions.ts'
import { actions } from '../../extensions/workspaces/server.ts'
import { Workspaces } from '../../extensions/workspaces/workspaces.ts'
import { git } from '../../lib/git.ts'
import { ConversationsApi } from '../../extensions/conversations/api.ts'
import { Subagents } from '../../extensions/subagents/api.ts'
import { until } from '../helpers.ts'
import { conversations, fixture, commit, holdGit } from './workspaces-integration-fixture.ts'

async function nestedFixture() {
  const f = await fixture()
  const parent = await f.create()
  await f.service.ready(parent, context)
  const parentWorkspace = (await f.service.get(parent, context))!
  await f.call(parent, 'subagent', {
    action: 'start',
    agent: 'worker',
    task: 'finish',
    isolate: 'worktree',
  })
  const child = Object.values(
    (await f.opened.harness.snapshot(Subagents, parent, context))!.agents,
  )[0].conversationId
  const childWorkspace = (await f.service.get(child, context))!
  return { f, parent, child, parentWorkspace, childWorkspace }
}

/** A ready workspace whose worktree Git removed, leaving its folder with only ignored local state, as `wrangler dev` does. */
async function leftover(unlanded: boolean) {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  if (unlanded) await commit(workspace.path, 'unlanded.txt')
  else {
    await commit(workspace.path)
    await f.service.land(id, context)
  }
  await git(workspace.source, 'worktree', 'remove', workspace.path)
  await mkdir(join(workspace.path, '.wrangler'), { recursive: true })
  await writeFile(join(workspace.path, '.wrangler/state.json'), '{}')
  return { f, id, workspace }
}

it.concurrent('pending warns about branch commits; release keeps only dirty or detached work and input restores branch commits', async () => {
  const f = await fixture()
  const clean = await f.create()
  const dirty = await f.create()
  const ahead = await f.create()
  for (const id of [clean, dirty, ahead]) await f.service.ready(id, context)
  const cleanWorkspace = (await f.service.get(clean, context))!
  const dirtyWorkspace = (await f.service.get(dirty, context))!
  const aheadWorkspace = (await f.service.get(ahead, context))!
  await commit(cleanWorkspace.path)
  await f.service.land(clean, context)
  await writeFile(join(dirtyWorkspace.path, 'dirty.txt'), 'dirty')
  const aheadTip = await commit(aheadWorkspace.path, 'ahead.txt')
  const expected = [
    { id: dirty, uncommitted: 1, unlanded: 0 },
    { id: ahead, uncommitted: 0, unlanded: 1 },
  ]
  expect(
    await actions.pending({ ids: [clean, dirty, ahead] }, { host: f.host } as ActionContext),
  ).toEqual(expected)
  // An in-flight row's work: every ready worktree, the landed one with nothing left, an unknown id left out.
  expect(
    await actions.progress({ ids: [clean, dirty, ahead, 999] }, { host: f.host } as ActionContext),
  ).toEqual([{ id: clean, uncommitted: 0, unlanded: 0 }, ...expected])
  expect(await f.service.release([clean, dirty, ahead], context)).toEqual([expected[0]])
  await expect(access(cleanWorkspace.path)).rejects.toThrow('ENOENT')
  expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(
    cleanWorkspace.path,
  )
  expect(await git(f.projectRoot, 'branch', '--list', cleanWorkspace.branch)).toBe('')
  expect((await f.service.get(clean, context))!.state).toBe('removed')
  expect(await readFile(join(dirtyWorkspace.path, 'dirty.txt'), 'utf8')).toBe('dirty')
  await expect(access(aheadWorkspace.path)).rejects.toThrow('ENOENT')
  expect((await f.service.get(ahead, context))!.state).toBe('removed')
  expect(await git(f.projectRoot, 'rev-parse', aheadWorkspace.branch)).toBe(aheadTip)
  expect(JSON.stringify(await f.call(ahead, 'bash', { command: 'git rev-parse HEAD' }))).toContain(
    aheadTip,
  )
  expect(await readFile(join(aheadWorkspace.path, 'ahead.txt'), 'utf8')).toBe('ahead.txt')
  await git(aheadWorkspace.path, 'checkout', '--detach')
  const detachedTip = await commit(aheadWorkspace.path, 'detached.txt')
  expect(await f.service.release([ahead], context)).toEqual([
    { id: ahead, uncommitted: 0, unlanded: 1 },
  ])
  expect((await f.service.get(ahead, context))!.state).toBe('ready')
  expect(await git(aheadWorkspace.path, 'rev-parse', 'HEAD')).toBe(detachedTip)
  expect(await git(f.projectRoot, 'rev-parse', aheadWorkspace.branch)).toBe(aheadTip)
  expect(await f.service.release([clean], context)).toEqual([])
})

it('sweep removes unrecorded clean worktrees and merged branches but keeps and reports dirty ones', async () => {
  const f = await fixture()
  await mkdir(join(f.home, 'worktrees'), { recursive: true })
  const clean = join(f.home, 'worktrees', '999')
  const dirty = join(f.home, 'worktrees', '998')
  await git(f.projectRoot, 'worktree', 'add', clean, '-b', 'ultimate/x-999')
  await git(f.projectRoot, 'worktree', 'add', dirty, '-b', 'ultimate/x-998')
  await writeFile(join(dirty, 'draft.txt'), 'draft')
  expect(await f.service.sweep(context)).toEqual([dirty])
  await expect(access(clean)).rejects.toThrow('ENOENT')
  expect(await git(f.projectRoot, 'branch', '--list', 'ultimate/x-999')).toBe('')
  expect(await readFile(join(dirty, 'draft.txt'), 'utf8')).toBe('draft')
  expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).toContain(dirty)
  expect(await git(f.projectRoot, 'branch', '--list', 'ultimate/x-998')).toContain('ultimate/x-998')
  expect(f.notice.mock.calls.flat().join('\n')).toContain(
    `unrecorded worktrees with changes: ${dirty}`,
  )
})
it.concurrent('release includes transitively owned checkouts but not unrelated conversations', async () => {
  const f = await fixture()
  const parent = await f.create()
  await f.service.ready(parent, context)
  const Owner = defineTask<null, { phase: 'done' }, null>({
    name: 'test.owner',
    version: 1,
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, ctx) =>
        runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        ),
    },
  })
  f.prepared.registry.install(defineExtension({ name: 'test-owner', tasks: [Owner] }))
  const childOf = async (owner: ConversationId) => {
    const id = await f.opened.harness.commit(async (tx) => {
      const taskId = await tx.createTask(Owner, null, {
        conversationId: owner,
        ownership: { kind: 'conversation' },
        background: true,
      })
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId } })
      await f.service.create(tx, child.id, f.projectRoot)
      return child.id
    }, context)
    f.opened.harness.resume()
    await f.service.ready(id, context)
    return id
  }
  const child = await childOf(parent)
  const grandchild = await childOf(child)
  const unrelated = await f.create()
  await f.service.ready(unrelated, context)
  const dirty = (await f.service.get(grandchild, context))!
  await writeFile(join(dirty.path, 'dirty.txt'), 'dirty')
  const expected = [{ id: grandchild, uncommitted: 1, unlanded: 0 }]
  expect(await f.service.pending([parent], context)).toEqual(expected)
  expect(await f.service.release([parent], context)).toEqual([
    ...expected,
    { id: child, uncommitted: 0, unlanded: 0, descendant: grandchild },
    { id: parent, uncommitted: 0, unlanded: 0, descendant: child },
  ])
  for (const id of [parent, child]) {
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('ready')
    await access(workspace.path)
  }
  expect((await f.service.get(unrelated, context))!.state).toBe('ready')
})

it.concurrent('release keeps a busy clean checkout without waiting', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  f.prepared.faux!.setResponses([
    async () => {
      await gate
      return fauxAssistantMessage('done')
    },
  ])
  const conversation = (await f.opened.harness.conversation(id, context))!
  const submission = await conversation.submit({ type: 'input', content: 'hold' }, context)
  try {
    expect(await f.service.release([id], context)).toEqual([
      { id, uncommitted: 0, unlanded: 0, busy: expect.stringMatching(/running|queued/) },
    ])
    expect((await f.service.get(id, context))!.state).toBe('ready')
  } finally {
    finish()
    await submission.wait(context)
    await conversation.waitForIdle(context)
  }
})

it.concurrent('next input recreates a released checkout at the current target and reruns setup before the model', async () => {
  const f = await fixture(['printf setup > setup-marker; printf setup-marker > .gitignore'])
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  // Commit setup output so release can safely remove the checkout.
  await git(workspace.path, 'add', '.gitignore')
  await git(workspace.path, 'commit', '-m', 'ignore setup marker')
  await f.service.land(id, context)
  expect(await f.service.release([id], context)).toEqual([])
  const tip = await commit(f.projectRoot, 'new-target.txt')
  let requested = false
  f.prepared.faux!.setResponses([
    async () => {
      expect((await f.service.get(id, context))!.state).toBe('ready')
      expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip)
      expect(await readFile(join(workspace.path, 'setup-marker'), 'utf8')).toBe('setup')
      requested = true
      return fauxAssistantMessage('recreated')
    },
  ])
  const conversation = (await f.opened.harness.conversation(id, context))!
  await (await conversation.submit({ type: 'input', content: 'resume' }, context)).wait(context)
  await conversation.waitForIdle(context)
  expect(requested).toBe(true)
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'ready',
    path: workspace.path,
    base: tip,
  })
  expect(await git(workspace.path, 'status', '--porcelain')).toBe('')
})

it.concurrent('open reconciles concluded checkouts in the background', async () => {
  const f = await fixture()
  const concluded = await f.create()
  const active = await f.create()
  for (const id of [concluded, active]) await f.service.ready(id, context)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded'] = [concluded]
  }, context)
  f.host.implement(
    ConversationsApi,
    conversations({
      concluded: async () => new Set([concluded]),
    }),
  )
  await f.reopen()
  await until(async () =>
    access((await f.service.get(concluded, context))!.path).then(
      () => false,
      () => true,
    ),
  )
  await expect(access((await f.service.get(concluded, context))!.path)).rejects.toThrow('ENOENT')
  expect((await f.service.get(active, context))!.state).toBe('ready')
})

it.concurrent('release handles failed checkouts but never removes detached unlanded work', async () => {
  const f = await fixture()
  const failed = await f.create()
  const detached = await f.create()
  for (const id of [failed, detached]) await f.service.ready(id, context)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(failed)].state = 'failed'
  }, context)
  const failedWorkspace = (await f.service.get(failed, context))!
  await writeFile(join(failedWorkspace.path, 'output.txt'), 'failed setup output')
  expect(await f.service.pending([failed], context)).toEqual([
    { id: failed, uncommitted: 1, unlanded: 0 },
  ])
  expect(await f.service.release([failed], context)).toEqual([
    { id: failed, uncommitted: 1, unlanded: 0 },
  ])
  await unlink(join(failedWorkspace.path, 'output.txt'))
  expect(await f.service.release([failed], context)).toEqual([])
  const workspace = (await f.service.get(detached, context))!
  await git(workspace.path, 'checkout', '--detach')
  const tip = await commit(workspace.path)
  expect(await f.service.release([detached], context)).toEqual([
    { id: detached, uncommitted: 0, unlanded: 1 },
  ])
  expect((await f.service.get(detached, context))!.state).toBe('ready')
  expect(
    JSON.stringify(await f.call(detached, 'bash', { command: 'git rev-parse HEAD' })),
  ).toContain(tip)
  expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(tip)
})

it.concurrent('aborting release finishes the current checkout and leaves the remaining batch untouched', async () => {
  const f = await fixture()
  const ids = [await f.create(), await f.create(), await f.create()]
  for (const id of ids) await f.service.ready(id, context)
  const workspacesBefore = await Promise.all(ids.map((id) => f.service.get(id, context)))
  const deletingBranch = await holdGit(f.projectRoot, 'branch')
  const controller = new AbortController()
  let finished = false
  const releasing = f.service.release(ids, context, controller.signal).then((kept) => {
    finished = true
    return kept
  })
  try {
    // Hold the first checkout's final branch deletion, after its folder has been removed.
    await deletingBranch.started()
    controller.abort()
    expect(finished).toBe(false)
    await expect(access(workspacesBefore[0]!.path)).rejects.toThrow('ENOENT')
  } finally {
    await deletingBranch.release()
    await releasing
  }
  expect(finished).toBe(true)
  expect(await git(f.projectRoot, 'branch', '--list', workspacesBefore[0]!.branch)).toBe('')
  const registered = await git(f.projectRoot, 'worktree', 'list', '--porcelain')
  for (let i = 1; i < ids.length; i++) {
    const workspace = workspacesBefore[i]!
    expect((await f.service.get(ids[i], context))!.state).toBe('ready')
    await access(workspace.path)
    expect(registered).toContain(workspace.path)
    expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toContain(
      workspace.branch,
    )
  }
})

it.concurrent('input admitted after release marks removed waits for deletion and recreates a usable checkout', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const harness = f.opened.harness
  const original = harness.commit.bind(harness)
  let proceed!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => {
    proceed = resolve
  })
  const marked = new Promise<void>((resolve) => {
    reached = resolve
  })
  let held = false
  const spy = vi
    .spyOn(harness, 'commit')
    .mockImplementation(
      async <T>(change: (tx: Tx) => T | Promise<T>, ctx: typeof context): Promise<T> => {
        const result = await original(change, ctx)
        if (!held && (await f.service.get(id, context))!.state === 'removed') {
          held = true
          reached()
          await gate
        }
        return result
      },
    )
  const releasing = f.service.release([id], context)
  const conversation = (await harness.conversation(id, context))!
  let request: ReturnType<typeof conversation.submit> | undefined
  try {
    await marked
    // The idle check and removed state are committed, but filesystem removal has not started.
    await access(workspace.path)
    request = conversation.submit({ type: 'input', content: 'resume during release' }, context)
    await request
  } finally {
    proceed()
    await releasing
    spy.mockRestore()
  }
  await (await request).wait(context)
  await conversation.waitForIdle(context)
  expect((await f.service.get(id, context))!.state).toBe('ready')
  await access(workspace.path)
  expect(await git(workspace.path, 'rev-parse', 'HEAD')).toBe(
    await git(f.projectRoot, 'rev-parse', 'HEAD'),
  )
})

it.concurrent.each([false, true])(
  'reopen finishes an interrupted release (folder already removed: %s)',
  async (removed) => {
    const f = await fixture()
    const id = await f.create()
    await f.service.ready(id, context)
    const workspace = (await f.service.get(id, context))!
    if (removed) await git(workspace.source, 'worktree', 'remove', workspace.path)
    // Both interruption windows: old removal-before-state, and state-before-removal.
    await f.opened.harness.commit(async (tx) => {
      ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = removed
        ? 'ready'
        : 'removed'
    }, context)
    f.host.implement(
      ConversationsApi,
      conversations({
        concluded: async () => new Set([id]),
      }),
    )
    await f.reopen()
    await until(async () => !(await git(f.projectRoot, 'branch', '--list', workspace.branch)))
    expect((await f.service.get(id, context))!.state).toBe('removed')
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    await f.call(id, 'bash', { command: 'pwd' })
    expect((await f.service.get(id, context))!.state).toBe('ready')
    await access(workspace.path)
  },
)

it.concurrent('reconcile and recreate keep new work found in an interrupted removal', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'precious.txt'), 'keep me')
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
  }, context)
  expect(await f.service.release([id], context)).toEqual([{ id, uncommitted: 1, unlanded: 0 }])
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
  }, context)
  await f.call(id, 'bash', { command: 'cat precious.txt' })
  expect((await f.service.get(id, context))!.state).toBe('ready')
  expect(await readFile(join(workspace.path, 'precious.txt'), 'utf8')).toBe('keep me')
})
it.concurrent('nested isolates release child before its source parent and can recreate both', async () => {
  const { f, parent, child, parentWorkspace, childWorkspace } = await nestedFixture()
  expect(childWorkspace.source).toBe(parentWorkspace.path)
  expect(await f.service.release([parent], context)).toEqual([])
  for (const workspace of [childWorkspace, parentWorkspace]) {
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
    expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toBe('')
  }
  expect(await f.service.release([parent], context)).toEqual([])
  await f.call(child, 'bash', { command: 'pwd' })
  for (const id of [parent, child]) {
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('ready')
    await access(workspace.path)
  }
})
it.concurrent('a dirty nested isolate keeps its source parent checkout', async () => {
  const { f, parent, child, parentWorkspace, childWorkspace } = await nestedFixture()
  expect(childWorkspace.source).toBe(parentWorkspace.path)
  await writeFile(join(childWorkspace.path, 'precious.txt'), 'keep me')
  expect(await f.service.release([parent], context)).toEqual([
    { id: child, uncommitted: 1, unlanded: 0 },
    { id: parent, uncommitted: 0, unlanded: 0, descendant: child },
  ])
  for (const workspace of [childWorkspace, parentWorkspace]) await access(workspace.path)
})

it.concurrent('failed setup while recreating a discarded branch preserves its unlanded commits', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const tip = await commit(workspace.path)
  await f.service.discard(id, context)
  f.host.projectSettings = async () => ({ isolates: { worktree: { setup: ['exit 1'] } } })
  await f.call(id, 'bash', { command: 'pwd' })
  expect((await f.service.get(id, context))!.state).toBe('failed')
  expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(tip)
})

it('resuming a child after its removal keeps the parent in the same release batch', async () => {
  const { f, parent, child, parentWorkspace, childWorkspace } = await nestedFixture()
  const deletingChildBranch = await holdGit(f.projectRoot, 'branch')
  const queues = f.host.resource('workspaces.land', () => new Map<string, Promise<unknown>>())
  const queued = vi.spyOn(queues, 'set')
  const releasing = f.service.release([parent], context)
  const conversation = (await f.opened.harness.conversation(child, context))!
  let request: ReturnType<typeof conversation.submit> | undefined
  try {
    await deletingChildBranch.started()
    expect((await f.service.get(child, context))!.state).toBe('removed')
    await expect(access(childWorkspace.path)).rejects.toThrow('ENOENT')
    request = conversation.submit(
      { type: 'input', content: 'resume child between removals' },
      context,
    )
    await request
    // The child readies its parent, then holds the parent's source queue while waiting for child removal.
    await until(
      () => queued.mock.calls.filter(([source]) => source === parentWorkspace.source).length >= 2,
    )
  } finally {
    await deletingChildBranch.release()
  }
  const kept = await releasing
  queued.mockRestore()
  await (await request).wait(context)
  await conversation.waitForIdle(context)
  expect(kept).toEqual([{ id: parent, uncommitted: 0, unlanded: 0, descendant: child }])
  for (const id of [parent, child]) {
    const workspace = (await f.service.get(id, context))!
    expect(workspace.state).toBe('ready')
    await access(workspace.path)
  }
})

it.concurrent('releases a detached checkout with no commits outside its branch or target and recreates at the target', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const tip = await commit(workspace.path)
  await f.service.land(id, context)
  await git(workspace.path, 'checkout', '--detach', workspace.base)
  expect(await f.service.release([id], context)).toEqual([])
  expect((await f.service.get(id, context))!.state).toBe('removed')
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  expect(JSON.stringify(await f.call(id, 'bash', { command: 'git rev-parse HEAD' }))).toContain(tip)
  expect((await f.service.get(id, context))!.state).toBe('ready')
})

it.concurrent('a branch deletion failure after removing the worktree stays removed and the next request recreates it', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  const branch = await holdGit(f.projectRoot, 'branch', true)
  const releasing = f.service.release([id], context)
  try {
    await branch.started()
    await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  } finally {
    await branch.release()
  }
  expect(await releasing).toEqual([{ id, uncommitted: 0, unlanded: 0, reason: expect.any(String) }])
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'removed',
    error: expect.any(String),
  })
  expect(await git(f.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(workspace.path)
  const result = await f.call(id, 'bash', { command: 'pwd' })
  expect(JSON.stringify(result)).toContain(workspace.path)
  expect((await f.service.get(id, context))!.state).toBe('ready')
  await access(workspace.path)
})

it.concurrent('a persistent branch deletion failure blocks tools with its reason while the model can explain', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(
    join(f.projectRoot, '.git/hooks/reference-transaction'),
    `#!/bin/sh
cat >/dev/null
[ "$1" = prepared ] || exit 0
case "$(ps -ww -p "$PPID" -o args=)" in "git branch -D "*) exit 1 ;; esac
`,
    { mode: 0o755 },
  )
  const kept = await f.service.release([id], context)
  expect(kept).toEqual([{ id, uncommitted: 0, unlanded: 0, reason: expect.any(String) }])
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(
    result?.role === 'toolResult' &&
      result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  ).toContain(kept[0].reason!)
  expect(f.writes).toBe(0)
  const conversation = (await f.opened.harness.conversation(id, context))!
  const view = await conversation.viewState(context)
  try {
    const reply = view.value.entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === 'assistant')
    expect(
      reply?.role === 'assistant' &&
        reply.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
    ).toContain(kept[0].reason!)
  } finally {
    view.dispose()
  }
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'removed',
    error: kept[0].reason,
  })
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
})

it.concurrent('recovery does not mark an unregistered folder ready or run tools there', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await f.service.release([id], context)
  await mkdir(workspace.path)
  await writeFile(join(workspace.path, 'unrelated.txt'), 'keep me')
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Workspace is removed:')
  expect(f.writes).toBe(0)
  expect((await f.service.get(id, context))!.state).toBe('removed')
  expect(await readFile(join(workspace.path, 'unrelated.txt'), 'utf8')).toBe('keep me')
})

it.concurrent('a tool call recreates a released checkout over a leftover folder of ignored files', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await f.service.release([id], context)
  // A dev server still running in the released folder writes its cache back.
  await writeFile(join(f.projectRoot, '.git/info/exclude'), '.vite/\n')
  await mkdir(join(workspace.path, '.vite/deps'), { recursive: true })
  await writeFile(join(workspace.path, '.vite/deps/chunk.js'), '')
  const result = await f.call(id, 'bash', { command: 'pwd' })
  expect(JSON.stringify(result)).toContain(workspace.path)
  expect(JSON.stringify(result)).not.toContain('Workspace is removed')
  expect((await f.service.get(id, context))!.state).toBe('ready')
  await expect(access(join(workspace.path, '.vite'))).rejects.toThrow('ENOENT')
})
it.concurrent('a tool call mid-run recreates a checkout released after the run began', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  f.prepared.faux!.setResponses([
    async () => {
      await git(workspace.source, 'worktree', 'remove', workspace.path)
      await f.opened.harness.commit(async (tx) => {
        ;(await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).items[String(id)].state = 'removed'
      }, context)
      return fauxAssistantMessage(fauxToolCall('write_commit', {}), { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('done'),
  ])
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(false)
  expect(f.writes).toBe(1)
  expect((await f.service.get(id, context))!.state).toBe('ready')
})
it.concurrent('release removes the leftover folder of a worktree Git already removed', async () => {
  const { f, id, workspace } = await leftover(false)
  expect(await f.service.pending([id], context)).toEqual([])
  expect(await f.service.release([id], context)).toEqual([])
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
  expect(await git(f.projectRoot, 'branch', '--list', workspace.branch)).toBe('')
  expect((await f.service.get(id, context))!.state).toBe('removed')
  expect(await git(f.projectRoot, 'status', '--porcelain')).toBe('')
})
it.concurrent('release keeps the unlanded branch of a worktree Git already removed', async () => {
  const { f, id, workspace } = await leftover(true)
  const tip = await git(f.projectRoot, 'rev-parse', workspace.branch)
  expect(await f.service.pending([id], context)).toEqual([])
  expect(await f.service.release([id], context)).toEqual([])
  expect(await git(f.projectRoot, 'rev-parse', workspace.branch)).toBe(tip)
  expect((await f.service.get(id, context))!.state).toBe('removed')
  await expect(access(workspace.path)).rejects.toThrow('ENOENT')
})
it.concurrent('release never removes a registered checkout whose .git file is broken', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  await writeFile(join(workspace.path, 'precious.txt'), 'keep me')
  await writeFile(join(workspace.path, '.git'), 'gitdir: /nowhere\n')
  // Git 2.56 words a .git file that points nowhere differently from earlier versions.
  await expect(f.service.release([id], context)).rejects.toThrow(
    /not a git repository|does not point to a valid repository/,
  )
  expect((await f.service.get(id, context))!).toMatchObject({
    state: 'ready',
    path: workspace.path,
  })
  expect(await readFile(join(workspace.path, 'precious.txt'), 'utf8')).toBe('keep me')
})
it.concurrent('release leaves a folder that a failed preparation found at the path', async () => {
  const f = await fixture()
  const id = await f.create()
  const workspace = (await f.service.get(id, context))!
  await mkdir(workspace.path, { recursive: true })
  await writeFile(join(workspace.path, 'foreign.txt'), 'not ours')
  await f.service.ready(id, context)
  expect((await f.service.get(id, context))!.state).toBe('failed')
  expect(await f.service.release([id], context)).toEqual([
    {
      id,
      uncommitted: 0,
      unlanded: 0,
      reason: expect.stringContaining('not a registered checkout'),
    },
  ])
  expect(await readFile(join(workspace.path, 'foreign.txt'), 'utf8')).toBe('not ours')
})

it.concurrent('the tool gate blocks a checkout removed after the provider request began', async () => {
  const f = await fixture()
  const id = await f.create()
  await f.service.ready(id, context)
  const workspace = (await f.service.get(id, context))!
  f.prepared.faux!.setResponses([
    async () => {
      await git(workspace.source, 'worktree', 'remove', workspace.path)
      return fauxAssistantMessage(fauxToolCall('write_commit', {}), { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('blocked'),
  ])
  const result = await f.call(id, 'write_commit')
  expect(result?.role === 'toolResult' && result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('Workspace checkout is missing or unregistered:')
  expect(f.writes).toBe(0)
})
