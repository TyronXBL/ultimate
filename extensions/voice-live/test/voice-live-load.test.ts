import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../../../server/harness.ts'
import { Standing } from '../../subagents/api.ts'
import type { VoiceLine } from '../refs.ts'
import { fauxServer, post, temp, until } from '../../../test/helpers.ts'
import { ultimateRoot, servers, fixture } from './voice-live-fixture.ts'

it.each([false, true])('loads Voice agents and facets only when enabled (%s)', async (enabled) => {
  const home = await temp('ultimate-voice-toggle-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: enabled ? ['voice-live'] : [] } }),
  )
  const probe = join(projectRoot, '.ultimate/extensions/probe')
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(probe, 'server.ts'),
    `import { SubagentsApi } from ${JSON.stringify(join(ultimateRoot, 'extensions/subagents/api.ts'))}
export const actions = {
  residents: (_args, { host, signal }) => host.need(SubagentsApi).residents({ signal }),
}
export default { name: 'probe' }
`,
  )
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome: home })
  servers.push(server)
  const residents = await post(server, '/api/extensions/probe/actions/residents', { args: null })
  expect([
    residents.status,
    residents.data.error,
    server.extensions.info().find((e) => e.name === 'probe')?.server?.error,
  ]).toEqual([200, undefined, undefined])
  expect(residents.data.result.some((agent: { name: string }) => agent.name === 'voice')).toBe(
    enabled,
  )
  const info = server.extensions.info().find((extension) => extension.name === 'voice-live')!
  expect(info.enabled).toBe(enabled)
  expect(Boolean(info.server)).toBe(enabled)
  const webFacets = await server.web.facets()
  expect(webFacets.some((path) => path.includes('/voice-live/'))).toBe(enabled)
  const rootAgent = await server.root.agent(context)
  expect(
    [...rootAgent.tools, ...rootAgent.deferred].some((tool) => tool.name.startsWith('voice_')),
  ).toBe(enabled)
  const definitions = await post(server, '/api/extensions/subagents/actions/definitions', {
    args: null,
  })
  expect(
    definitions.data.result.definitions.some((agent: { name: string }) => agent.name === 'voice'),
  ).toBe(enabled)
  if (!enabled) return
  // Extension-owned definitions stay built-ins, with both overlay scopes and edits read on demand.
  for (const [directory, text] of [
    [join(home, '.ultimate/agents'), 'User voice additions.'],
    [join(projectRoot, '.ultimate/agents'), 'Project voice additions.'],
  ]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'voice.md'), `---\nname: voice\naddTools: []\n---\n\n${text}\n`)
  }
  const definition = await post(server, '/api/extensions/subagents/actions/definition', {
    args: { name: 'voice' },
  })
  expect(definition.data.result.definition).toMatchObject({
    source: 'builtin',
    instructions: expect.stringContaining('User voice additions.'),
    overlays: [
      join(home, '.ultimate/agents/voice.md'),
      join(projectRoot, '.ultimate/agents/voice.md'),
    ],
  })
  expect(definition.data.result.definition.instructions).toContain('Project voice additions.')
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'voice' },
  })
  expect(standing.status).toBe(200)
  // Retiring a definition preserves its conversation as history, not a standing agent.
  await rm(join(home, '.ultimate/agents/voice.md'))
  await rm(join(projectRoot, '.ultimate/agents/voice.md'))
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['voice-live'] } }),
  )
  await until(
    async () => !(await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice,
  )
  expect(
    await server.harness.conversation(standing.data.result as ConversationId, context),
  ).toBeDefined()
  const retired = await post(server, '/api/extensions/conversations/actions/conclude', {
    args: { ids: [standing.data.result] },
  })
  expect(retired.status).toBe(200)
})

it('delivers a stopped-input notice and agent input with distinct request ids', async () => {
  const f = await fixture()
  f.setAnswer('HOLD')
  await f.action('heard', { text: 'check tests' })
  await until(async () => (await f.entries(f.main)).some((e) => e.kind === 'voice.utterance'))
  await (await f.server.harness.conversation(f.main, context))!.abort(context)
  await until(() => f.answers.length > 0)
  expect(f.answers[0]).toContain('Ultimate did not answer that request.')
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  const forwarded = lines.find((e) => (e.data as VoiceLine).forwarded)!
  expect(lines.find((e) => (e.data as VoiceLine).role === 'notice')?.data).toMatchObject({
    role: 'notice',
    re: forwarded.id,
    text: 'Ultimate was stopped before it answered.',
  })
})
