import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { fauxServer, post, temp, removeTemp } from './helpers.ts'
import { context } from '../server/harness.ts'
import { git } from '../lib/git.ts'
import { projectDecision } from '../server/project-setup.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'

it('offers setup only to named definitions, refuses inapplicable cards, and deduplicates user-only choices', async () => {
  const home = await temp('ultimate-setup-cards-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate'), { recursive: true })
  await writeFile(join(project, '.ultimate/settings.json'), '{}')
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(home, '.ultimate/agents/setup-guide.md'),
    '---\nname: setup-guide\ndescription: Setup guide\nresident: true\ntools: [setup, codemode]\n---\nHelp with setup.',
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
  })
  try {
    expect((await server.root.agent(context)).tools.map((tool) => tool.name)).not.toContain('setup')
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')
      if (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.startsWith('CALL ')
      ) {
        const { name, args } = JSON.parse(last.content.slice(5))
        return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
      }
      return fauxAssistantMessage('Ready')
    }
    server.host.faux!.setResponses([route])
    const standing = await post(server, '/api/extensions/subagents/actions/standing', {
      args: { name: 'setup-guide' },
    })
    expect(standing.status).toBe(200)
    const conversation = (await server.harness.conversation(standing.data.result, context))!
    expect((await conversation.agent(context)).tools.map((tool) => tool.name)).toContain('setup')
    const run = async (name: string, args: Record<string, string>) => {
      await conversation.submit(
        { type: 'input', content: 'CALL ' + JSON.stringify({ name, args }) },
        context,
      )
      await server.harness.waitForIdle(context)
      const view = await conversation.viewState(context)
      return view.value.entries.findLast((entry) => entry.kind === 'pi.tool-result')!
    }
    expect(JSON.stringify(await run('setup', { card: 'project' }))).toContain('undecided')
    await post(server, '/api/extensions/onboarding/actions/decide', { args: { local: false } })
    expect(JSON.stringify(await run('setup', { card: 'project' }))).toContain('already decided')
    await git(project, 'init', '-b', 'main')
    await git(
      project,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    )
    expect(JSON.stringify(await run('setup', { card: 'git' }))).toContain('already isolatable')
    expect(JSON.stringify(await run('setup', { card: 'extensions' }))).toContain(
      'Choose recommended extensions',
    )
    const choice = {
      card: 'extensions',
      extensions: { messages: true, faux: false },
      toolCallId: 'setup-1',
    }
    const receipts = await Promise.all(
      [0, 1].map(() =>
        post(server, '/api/extensions/onboarding/actions/choose', {
          args: choice,
          conversationId: conversation.id,
        }),
      ),
    )
    expect(receipts.map((receipt) => receipt.status)).toEqual([200, 200])
    await server.harness.waitForIdle(context)
    const entries = (await conversation.viewState(context)).value.entries.filter(
      (entry) => entry.kind === 'onboarding.choice',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].data).toEqual({
      card: choice.card,
      toolCallId: choice.toolCallId,
      summary: 'enabled messages; disabled faux',
    })
    expect(JSON.stringify(entries[0].model)).toContain(
      'Setup choice (extensions): enabled messages; disabled faux',
    )
    const otherTab = await post(server, '/api/extensions/onboarding/actions/choose', {
      args: { ...choice, extensions: { messages: false, faux: true } },
      conversationId: conversation.id,
    })
    expect(otherTab.status).toBe(500)
    expect(otherTab.data.error).toContain('already has a different choice')
    expect(
      JSON.parse(await readFile(join(home, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toMatchObject({ enable: ['messages'], disable: ['faux'] })

    // Fail after the setting is applied but before admission. Retrying must still notify the agent once.
    const retry = { card: 'project', local: true, toolCallId: 'retry-project' }
    const lookup = vi.spyOn(server.harness, 'conversation').mockResolvedValueOnce(conversation)
    const submit = vi
      .spyOn(conversation, 'submit')
      .mockRejectedValueOnce(new Error('Interrupted before notification'))
    try {
      const interrupted = await post(server, '/api/extensions/onboarding/actions/choose', {
        args: retry,
        conversationId: conversation.id,
      })
      expect(interrupted.status).toBe(500)
      expect(interrupted.data.error).toContain('Interrupted before notification')
    } finally {
      submit.mockRestore()
      lookup.mockRestore()
    }
    expect(server.system.current().project.decision).toBe(true)
    expect(
      (await conversation.viewState(context)).value.entries.filter(
        (entry) =>
          entry.kind === 'onboarding.choice' &&
          (entry.data as { toolCallId: string }).toolCallId === retry.toolCallId,
      ),
    ).toHaveLength(0)
    for (let i = 0; i < 2; i++)
      expect(
        (
          await post(server, '/api/extensions/onboarding/actions/choose', {
            args: retry,
            conversationId: conversation.id,
          })
        ).status,
      ).toBe(200)
    await server.harness.waitForIdle(context)
    expect(
      (await conversation.viewState(context)).value.entries.filter(
        (entry) =>
          entry.kind === 'onboarding.choice' &&
          (entry.data as { toolCallId: string }).toolCallId === retry.toolCallId,
      ),
    ).toHaveLength(1)
    expect(
      (
        await post(server, '/api/extensions/onboarding/actions/applyFirstRun', {
          args: { extensions: { info: false, plan: true } },
        })
      ).status,
    ).toBe(200)
    expect(
      JSON.parse(await readFile(join(home, '.ultimate/settings.json'), 'utf8')).extensions,
    ).toMatchObject({ enable: ['messages', 'plan'], disable: ['faux', 'info'] })
    expect(
      JSON.stringify(
        await run('codemode', {
          code: `return await ultimate.action('onboarding', 'choose', ${JSON.stringify(choice)});`,
        }),
      ),
    ).toContain('onboarding/choose is a user-only action')
    expect(
      JSON.stringify(
        await run('codemode', {
          code: "return await ultimate.action('onboarding', 'start', {root: 1});",
        }),
      ),
    ).toContain('onboarding/start is a user-only action')
    expect(
      JSON.stringify(
        await run('codemode', { code: "return await ultimate.action('workspaces', 'setupGit');" }),
      ),
    ).toContain('workspaces/setupGit is a user-only action')
    // Absence is checked independently of the remembered project decision.
    await rename(join(project, '.ultimate'), join(home, 'setup-backup'))
    expect(JSON.stringify(await run('setup', { card: 'project' }))).toContain('no .ultimate/ setup')
  } finally {
    await server.close()
    await removeTemp(home)
  }
})

it('does not inherit a parent project choice', async () => {
  const home = await temp('ultimate-trust-')
  try {
    const project = join(home, 'parent/child')
    await mkdir(project, { recursive: true })
    new ProjectTrustStore(join(home, '.ultimate')).set(join(home, 'parent'), true)
    expect(projectDecision(project, home)).toBe(null)
  } finally {
    await removeTemp(home)
  }
})

it('shares one choice between a checkout and its linked worktrees', async () => {
  const home = await temp('ultimate-trust-worktree-')
  try {
    const main = join(home, 'main')
    const worktree = join(home, 'worktree')
    await mkdir(join(main, '.ultimate/agents'), { recursive: true })
    await writeFile(join(main, '.ultimate/agents/y.md'), '---\nname: y\ndescription: Y\n---\nY.')
    await git(main, 'init', '-b', 'main')
    await git(main, 'add', '.')
    await git(main, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'base')
    await git(main, 'worktree', 'add', worktree, '-b', 'branch')
    expect(projectDecision(worktree, home)).toBe(null)
    new ProjectTrustStore(join(home, '.ultimate')).set(main, true)
    expect(projectDecision(worktree, home)).toBe(true)
    // A worktree's own entry is not consulted, and choosing from it decides for the checkout.
    new ProjectTrustStore(join(home, '.ultimate')).set(worktree, false)
    expect(projectDecision(worktree, home)).toBe(true)
    const server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: worktree,
      userHome: home,
      home: join(home, 'state'),
      localSetup: false,
    })
    try {
      expect(server.system.current().project.decision).toBe(true)
      await post(server, '/api/extensions/onboarding/actions/decide', { args: { local: false } })
      expect(projectDecision(main, home)).toBe(false)
    } finally {
      await server.close()
    }
  } finally {
    await removeTemp(home)
  }
})

it('boots with corrupt trust, discloses project replacements, and recovers after repair', async () => {
  const home = await temp('ultimate-corrupt-trust-')
  const project = join(home, 'project')
  await mkdir(join(project, '.ultimate/extensions/codemode'), { recursive: true })
  await mkdir(join(home, '.ultimate'), { recursive: true })
  await writeFile(join(home, '.ultimate/trust.json'), '{bad')
  await writeFile(join(project, '.ultimate/README.md'), 'x'.repeat(16383) + '😀')
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer({
      ultimateRoot: resolve('.'),
      projectRoot: project,
      userHome: home,
      home: join(home, 'state'),
      localSetup: false,
    })
    expect(server.system.current().project.decision).toBe(null)
    expect(server.system.current().extensionDiagnostics.join(' ')).toContain(
      'Failed to read trust store',
    )
    expect(server.system.current().project.readme).toBe('x'.repeat(16383) + '😀')
    const status = await post(server, '/api/extensions/onboarding/actions/status', { args: {} })
    expect(status.data.result.adds.replaces).toEqual(['codemode'])
    const rows = await post(server, '/api/extensions/onboarding/actions/extensions', { args: {} })
    expect(rows.data.result.find((row: { name: string }) => row.name === 'codemode')).toMatchObject(
      { source: 'project', replaces: 'builtin', enabled: false },
    )
    await writeFile(join(home, '.ultimate/trust.json'), '{}')
    const choice = await post(server, '/api/extensions/onboarding/actions/decide', {
      args: { local: true },
    })
    expect(choice.status).toBe(200)
    const userFile = join(home, '.ultimate/settings.json')
    await writeFile(userFile, '{"custom":1}')
    const adopted = await post(server, '/api/extensions/onboarding/actions/adoptProjectSetup', {
      args: {},
    })
    expect(adopted.status).toBe(200)
    expect(await readFile(userFile, 'utf8')).toBe('{"custom":1}')
    expect(server.system.current().extensionDiagnostics.join(' ')).not.toContain(
      'Failed to read trust store',
    )
  } finally {
    await server?.close()
    await removeTemp(home)
  }
})
