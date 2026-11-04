import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fauxServer, post, temp, removeTemp, trimmedSourceCopy } from './helpers.ts'
import { context } from '../server/harness.ts'
import { projectDecision } from '../server/project-setup.ts'
import { updateSettings } from '../lib/settings.ts'
import { firstRunOf } from '../extensions/onboarding/onboarded.ts'

it('gates project resources, remembers choices, and applies onboarding settings actions live', async () => {
  const home = await temp('ultimate-onboarding-')
  const project = join(home, 'project')
  const config = join(project, '.ultimate')
  const userFile = join(home, '.ultimate/settings.json')
  const projectFile = join(config, 'settings.json')
  await mkdir(join(config, 'extensions/x'), { recursive: true })
  await mkdir(join(config, 'agents'), { recursive: true })
  await mkdir(join(config, 'skills/local-skill'), { recursive: true })
  await writeFile(
    join(config, 'extensions/x/server.ts'),
    "import { defineExtension } from '@earendil-works/pi-durable'; export default defineExtension({ name: 'x' })",
  )
  await writeFile(join(config, 'extensions/x/web.tsx'), 'export default {}')
  await writeFile(
    join(config, 'extensions/x/README.md'),
    '# X\n\nA local extension. Another sentence.',
  )
  await writeFile(
    join(config, 'agents/y.md'),
    '---\nname: y\ndescription: Project agent\n---\nInspect the project.',
  )
  await writeFile(
    join(config, 'skills/local-skill/SKILL.md'),
    '---\nname: local-skill\ndescription: Project skill\n---\nInspect.',
  )
  await writeFile(join(config, 'README.md'), 'Project setup.\n')
  await writeFile(
    projectFile,
    JSON.stringify({
      defaultSurface: 'workbench',
      custom: { keep: 1 },
      extensions: { disable: ['automations'], extra: 'keep' },
    }),
  )
  // This test boots three times: its source copy keeps only the extensions it toggles besides the core tier.
  const ultimateRoot = await trimmedSourceCopy(home, ['automations', 'splash', 'sounds', 'info'])
  const options = {
    ultimateRoot,
    projectRoot: project,
    userHome: home,
    home: join(home, 'state'),
    localSetup: false,
    firstRun: true,
  }
  let server: Awaited<ReturnType<typeof fauxServer>> | undefined
  try {
    server = await fauxServer(options)
    const action = async (name: string, args: unknown = {}) => {
      const response = await post(server!, `/api/extensions/onboarding/actions/${name}`, { args })
      expect(response.status).toBe(200)
      return response.data.result
    }
    const enabled = (name: string) =>
      server!.extensions.info().find((entry) => entry.name === name)?.enabled
    const web = async () => server!.web.facets()
    const tools = async () => (await server!.root.agent(context)).tools.map((tool) => tool.name)
    for (const args of [
      {},
      { extensions: { plan: 'yes' } },
      { extensions: {}, local: 1 },
      { extensions: { '': true } },
      { extensions: { ' ': false } },
    ])
      expect(
        (await post(server, '/api/extensions/onboarding/actions/applyFirstRun', { args })).status,
      ).toBe(500)
    expect(await action('status')).toMatchObject({
      firstRun: true,
      // Undecided: the project's settings are not applied, but the page shows what they would enable.
      adds: {
        agents: ['y'],
        skills: ['local-skill'],
        extensions: ['x'],
        replaces: [],
        enable: [],
        disable: ['automations'],
      },
    })
    expect(server.system.current().project).toMatchObject({
      config: true,
      decision: null,
      settings: {},
    })
    expect(enabled('x')).toBe(false)
    expect(enabled('automations')).toBe(true)
    expect(await tools()).toContain('automation')
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(false)
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'x'),
    ).toMatchObject({
      source: 'project',
      enabled: false,
      layer: 'folder',
      readme: 'A local extension.',
    })
    // details: the contract summary, catalogue edges and refs events of a loaded extension; tool descriptions in info.
    const log = await action('details', { name: 'messages' })
    expect(log.summary).not.toBe('')
    expect(log.provides).toContain('messages')
    expect(log.needs).toContain('subagents')
    expect(log.events).toEqual(expect.arrayContaining(['board.sent']))
    expect(
      server.extensions.info().find((entry) => entry.name === 'messages')?.server?.tools,
    ).toContainEqual({ name: 'message', description: expect.stringMatching(/\S/) })
    expect(
      (await post(server, '/api/extensions/onboarding/actions/details', { args: { name: 'nope' } }))
        .data.error,
    ).toContain('Unknown extension "nope"')
    const denied = await post(server, '/api/extensions/onboarding/actions/setExtension', {
      args: { name: 'splash', enabled: false, scope: 'project' },
    })
    expect(denied.status).toBe(500)
    expect(denied.data.error).toContain('local setup')
    await action('decide', { local: true })
    expect(enabled('x')).toBe(true)
    expect(enabled('automations')).toBe(false)
    expect(await tools()).not.toContain('automation')
    expect((await web()).some((path) => path.endsWith('/x/web.tsx'))).toBe(true)
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(true)
    expect(projectDecision(project, home)).toBe(true)
    await server.close()
    server = await fauxServer(options)
    expect(server.system.current().project.decision).toBe(true)
    expect(enabled('x')).toBe(true)
    await action('setExtension', { name: 'splash', enabled: false, scope: 'project' })
    expect(enabled('splash')).toBe(false)
    expect((await web()).some((path) => path.endsWith('/splash/web.tsx'))).toBe(false)
    await action('setExtension', { name: 'splash', enabled: true, scope: 'project' })
    expect(enabled('splash')).toBe(true)
    expect((await web()).some((path) => path.endsWith('/splash/web.tsx'))).toBe(true)
    const projectSettings = JSON.parse(await readFile(projectFile, 'utf8'))
    expect(projectSettings).toMatchObject({
      custom: { keep: 1 },
      defaultSurface: 'workbench',
      extensions: { extra: 'keep', enable: ['splash'], disable: ['automations'] },
    })
    await Promise.all(
      ['info', 'documents'].map((name) =>
        action('setExtension', { name, enabled: true, scope: 'user' }),
      ),
    )
    expect(JSON.parse(await readFile(userFile, 'utf8')).extensions.enable).toEqual(
      expect.arrayContaining(['info', 'documents']),
    )
    await action('setExtension', { name: 'sounds', enabled: false, scope: 'user' })
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toEqual({
      extensions: { enable: expect.arrayContaining(['info', 'documents']), disable: ['sounds'] },
    })
    await writeFile(
      userFile + '.tmp',
      JSON.stringify({ custom: 'user', extensions: { disable: ['sounds'], extra: 2 } }),
    )
    await rename(userFile + '.tmp', userFile)
    await action('setExtension', { name: 'sounds', enabled: true, scope: 'user' })
    expect(enabled('sounds')).toBe(true)
    expect((await web()).some((path) => path.endsWith('/sounds/web.tsx'))).toBe(true)
    await action('setExtension', { name: 'sounds', enabled: false, scope: 'user' })
    expect(enabled('sounds')).toBe(false)
    expect((await web()).some((path) => path.endsWith('/sounds/web.tsx'))).toBe(false)
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toMatchObject({
      custom: 'user',
      extensions: { extra: 2, enable: [], disable: ['sounds'] },
    })
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'splash').layer,
    ).toBe('project')
    expect(
      (await action('extensions')).find((entry: { name: string }) => entry.name === 'sounds').layer,
    ).toBe('user')
    await action('decide', { local: false })
    expect(enabled('x')).toBe(false)
    expect(enabled('automations')).toBe(true)
    expect(await tools()).toContain('automation')
    expect((await web()).some((path) => path.endsWith('/x/web.tsx'))).toBe(false)
    expect(server.system.current().skills.some((skill) => skill.name === 'local-skill')).toBe(false)
    const adoptDenied = await post(server, '/api/extensions/onboarding/actions/adoptProjectSetup', {
      args: {},
    })
    expect(adoptDenied.status).toBe(500)
    await action('decide', { local: true })
    await action('adoptProjectSetup')
    await action('decide', { local: false })
    expect(enabled('automations')).toBe(false)
    expect(JSON.parse(await readFile(userFile, 'utf8'))).toMatchObject({
      custom: 'user',
      extensions: { extra: 2, enable: ['splash'], disable: ['sounds', 'automations'] },
    })
    // `"onboarding": false` in the user's settings skips the first run without its marker.
    await updateSettings(userFile, (value) => {
      value.onboarding = false
    })
    expect(await action('status')).toMatchObject({ firstRun: false, off: true })
    await updateSettings(userFile, (value) => {
      delete value.onboarding
    })
    expect(await action('status')).toMatchObject({ firstRun: true, off: false })
    await action('firstRunDone')
    expect((await action('status')).firstRun).toBe(false)
    await server.close()
    server = await fauxServer(options)
    expect(server.system.current().project.decision).toBe(false)
    expect(enabled('x')).toBe(false)
    expect((await action('status')).firstRun).toBe(false)
  } finally {
    await server?.close()
    await removeTemp(home)
  }
})

it.each([
  // 33f42e7f: `"onboarding": false` turns the first run off, marker or not.
  ['setting off, no marker', true, false, 'off'],
  ['setting off, marked', true, true, 'off'],
  ['no marker', false, false, 'pending'],
  ['marked', false, true, 'done'],
] as const)('first run: %s', (_name, off, marked, expected) => {
  expect(firstRunOf(off, marked)).toBe(expected)
})
