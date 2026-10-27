// Load the faux provider's token-pacing mock before server modules.
import { fauxServer, sourceCopy, temp } from './helpers.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import {
  discoverAgents,
  parseDefinition,
  parseOverlay,
  serializeDefinition,
} from '../lib/agents.ts'
import { context } from '../server/harness.ts'
import { Subagents } from '../extensions/subagents/api.ts'

const definition = (fields: string) =>
  `---\nname: restricted\ndescription: Restricted helper\n${fields}\n---\nDo the assigned work.\n`

it('parses denyTools as a string list without validating names', async () => {
  const modelRuntime = await ModelRuntime.create()
  expect(
    parseDefinition(definition('denyTools: [instance, unknown-tool]'), 'agent.md'),
  ).toMatchObject({
    denyTools: ['instance', 'unknown-tool'],
  })
  expect(parseDefinition(definition('denyTools: []'), 'agent.md').denyTools).toEqual([])
  for (const value of ['instance', '[instance, 1]', 'null', '{instance: true}']) {
    expect(() => parseDefinition(definition(`denyTools: ${value}`), 'agent.md')).toThrow(
      'denyTools must be a list of tool names',
    )
    expect(() =>
      parseOverlay(definition(`addTools: []\ndenyTools: ${value}`), 'overlay.md', modelRuntime),
    ).toThrow('denyTools must be a list of tool names')
  }
})

it('adds overlay denials to the base list, preserving it through an empty overlay', async () => {
  const root = await temp('ultimate-deny-overlay-')
  const userHome = join(root, 'user')
  await mkdir(join(root, 'agents'))
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(join(root, 'agents/restricted.md'), definition('denyTools: [instance]'))
  await writeFile(
    join(userHome, '.ultimate/agents/01-deny.md'),
    definition('addTools: []\ndenyTools: [instance, unknown-tool]'),
  )
  await writeFile(
    join(userHome, '.ultimate/agents/02-empty.md'),
    definition('addTools: []\ndenyTools: []'),
  )
  const discovered = await discoverAgents(root, root, userHome, await ModelRuntime.create())
  expect(discovered.errors).toEqual([])
  expect(discovered.definitions).toMatchObject([
    { name: 'restricted', denyTools: ['instance', 'unknown-tool'] },
  ])
})

it('resolves a fallback list, lets an overlay replace it, and reads a serialized one back', async () => {
  const root = await temp('ultimate-fallback-')
  const userHome = join(root, 'user')
  await mkdir(join(root, 'agents'))
  await mkdir(join(userHome, '.ultimate/agents'), { recursive: true })
  await writeFile(
    join(root, 'agents/restricted.md'),
    definition('fallback: [anthropic/claude-opus-4-8, anthropic/claude-opus-5:high]'),
  )
  const modelRuntime = await ModelRuntime.create()
  const found = await discoverAgents(root, root, userHome, modelRuntime)
  expect(found.errors).toEqual([])
  expect(found.definitions[0].fallback).toEqual([
    { provider: 'anthropic', modelId: 'claude-opus-4-8' },
    { provider: 'anthropic', modelId: 'claude-opus-5', thinking: 'high' },
  ])
  // An overlay's list replaces the base one.
  await writeFile(
    join(userHome, '.ultimate/agents/01-fallback.md'),
    definition('addTools: []\nfallback: [anthropic/claude-haiku-4-5]'),
  )
  const overlaid = await discoverAgents(root, root, userHome, modelRuntime)
  expect(overlaid.errors).toEqual([])
  expect(overlaid.definitions[0].fallback).toEqual([
    { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
  ])
  // Written out again, the field reads back as the same list.
  const text = serializeDefinition(
    'restricted',
    {
      description: 'Restricted helper',
      fallback: ['anthropic/claude-opus-4-8', 'anthropic/claude-opus-5:high'],
    },
    'Do the assigned work.',
  )
  expect(text).toContain('fallback: [anthropic/claude-opus-4-8, anthropic/claude-opus-5:high]')
  const roundtrip = join(root, 'roundtrip')
  await mkdir(join(roundtrip, 'agents'), { recursive: true })
  await writeFile(join(roundtrip, 'agents/restricted.md'), text)
  const read = await discoverAgents(roundtrip, roundtrip, join(root, 'nouser'), modelRuntime)
  expect(read.errors).toEqual([])
  expect(read.definitions[0]).toMatchObject({
    name: 'restricted',
    fallback: [
      { provider: 'anthropic', modelId: 'claude-opus-4-8' },
      { provider: 'anthropic', modelId: 'claude-opus-5', thinking: 'high' },
    ],
  })
})

it('denies instance to children with inherited or explicit tools without changing the parent', async () => {
  const home = await temp('ultimate-deny-child-')
  const root = await sourceCopy(home)
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  for (const name of ['inherited', 'explicit'])
    await writeFile(
      join(home, `.ultimate/agents/${name}.md`),
      definition(
        `denyTools: [instance, unknown-tool]${name === 'explicit' ? '\ntools: [read, instance]' : ''}`,
      ).replace('name: restricted', `name: ${name}`),
    )
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test' }),
  )
  const server = await fauxServer({ ultimateRoot: root, home: join(home, 'state'), userHome: home })
  try {
    const route: FauxResponseFactory = (transcript) => {
      server.host.faux!.appendResponses([route])
      const last = transcript.messages.findLast((message) => message.role !== 'system')!
      if (
        last.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.startsWith('CALL ')
      )
        return fauxAssistantMessage([fauxToolCall('subagent', JSON.parse(last.content.slice(5)))], {
          stopReason: 'toolUse',
        })
      return fauxAssistantMessage('Finished')
    }
    server.host.faux!.setResponses([route])
    const parentTools = (await server.root.agent(context)).tools.map((tool) => tool.name)
    expect(parentTools).toContain('instance')
    for (const name of ['inherited', 'explicit']) {
      await (
        await server.root.submit(
          {
            type: 'input',
            content: `CALL ${JSON.stringify({ action: 'start', agent: name, task: 'Inspect tools' })}`,
          },
          context,
        )
      ).wait(context)
      const index = await server.harness.snapshot(Subagents, server.root.id, context)
      const record = Object.values(index!.agents).find((child) => child.agent === name)
      expect(record).toBeDefined()
      const child = (await server.harness.conversation(record!.conversationId, context))!
      const tools = (await child.agent(context)).tools.map((tool) => tool.name)
      expect(tools).toContain('read')
      expect(tools).not.toContain('instance')
      expect(tools).not.toContain('subagent')
      expect(tools).toEqual(
        name === 'explicit'
          ? ['read']
          : parentTools.filter((tool) => !['instance', 'subagent'].includes(tool)),
      )
      expect((await server.root.agent(context)).tools.map((tool) => tool.name)).toEqual(parentTools)
    }
  } finally {
    await server.close()
  }
})
