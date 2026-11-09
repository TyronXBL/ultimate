// Load the faux provider's token-pacing mock before server modules.
import { temp } from './helpers.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@earendil-works/pi-durable'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import {
  definitionAgent,
  discoverAgents,
  parseDefinition,
  parseOverlay,
  serializeDefinition,
} from '../lib/agents.ts'
import type { AgentDefinition } from '../lib/agents.ts'

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

it("filters a child definition's tools from the parent's without changing the parent", async () => {
  const names = (list: unknown) => (list as { name: string }[]).map((tool) => tool.name)
  const tool = (name: string, deferred = false) => ({ name, deferred })
  const parent = {
    tools: ['read', 'bash', 'instance', 'subagent'].map((name) => tool(name)),
    deferred: [tool('lookup', true)],
    extensions: [],
    model: { provider: 'anthropic', modelId: 'claude-opus-4-1' },
    thinkingLevel: 'high',
  } as unknown as Agent
  const before = structuredClone(parent)
  const runtime = await ModelRuntime.create()
  const cases: {
    name: string
    fields: Partial<AgentDefinition>
    exclude?: string[]
    tools: string[]
    add: string[]
  }[] = [
    {
      name: 'inherits the parent minus denied tools, ignoring unknown names',
      fields: { denyTools: ['instance', 'unknown-tool'] },
      tools: ['read', 'bash', 'subagent', 'lookup'],
      add: [],
    },
    {
      name: 'keeps only the listed tools that are not denied',
      fields: { tools: ['read', 'instance'], denyTools: ['instance'] },
      tools: ['read'],
      add: [],
    },
    {
      name: 'adds a named deferred tool',
      fields: { tools: ['read', 'lookup'] },
      tools: ['read', 'lookup'],
      add: ['lookup'],
    },
    {
      name: 'adds a deferred tool named by an overlay',
      fields: { addTools: ['lookup'] },
      tools: ['read', 'bash', 'instance', 'subagent', 'lookup'],
      add: ['lookup'],
    },
    {
      name: 'does not add a denied deferred tool',
      fields: { tools: ['read', 'lookup'], denyTools: ['lookup'] },
      tools: ['read'],
      add: [],
    },
    {
      name: 'removes an excluded tool from both lists',
      fields: { tools: ['read', 'subagent', 'lookup'], addTools: ['subagent'] },
      exclude: ['subagent'],
      tools: ['read', 'lookup'],
      add: ['lookup'],
    },
  ]
  for (const { name, fields, exclude, tools, add } of cases) {
    const change = definitionAgent(
      { name: 'child', description: 'Child', path: 'child.md', instructions: 'Work.', ...fields },
      parent,
      runtime,
      { excludeTools: exclude },
    )
    expect({
      name,
      tools: names(change.tools),
      add: names((change.modelTools as { add: unknown }).add),
    }).toEqual({ name, tools, add })
  }
  expect(parent).toEqual(before)
})
