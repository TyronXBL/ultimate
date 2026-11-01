import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ModelRuntime, ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import { discoverAgents, parseDefinition, serializeDefinition } from '../lib/agents.ts'
import type { DefinitionFields } from '../lib/agents.ts'
import { removeTemp, temp } from './helpers.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await removeTemp(path)
})
async function directory() {
  const path = await temp('ultimate-agents-')
  directories.push(path)
  return path
}
const definition = (body = 'Original instructions') =>
  `---\nname: scout\ndescription: Search\ntools: [read, bash]\n---\n${body}\n`

it('parses definitions with Pi frontmatter and validates their fields', () => {
  expect(
    parseDefinition(
      '---\nname: scout\ndescription: >\n  A read-only scout\n  that searches.\nmodel: openai-codex/gpt-5.4\nthinking: max\ntools:\n  - read\n  - bash\n---\nSearch\n',
      'scout.md',
    ),
  ).toEqual({
    name: 'scout',
    description: 'A read-only scout that searches.',
    path: 'scout.md',
    instructions: 'Search',
    model: 'openai-codex/gpt-5.4',
    thinking: 'max',
    tools: ['read', 'bash'],
  })
  for (const [from, to, error] of [
    [
      'tools: [read, bash]',
      'tools: [read, bash]\nthinking: nonsense',
      'thinking must be one of off, minimal, low, medium, high, xhigh, max',
    ],
    ['description: Search', 'description: " "', 'description is required'],
    ['name: scout', 'name: a scout', 'name must be a nonempty identifier'],
    ['tools: [read, bash]', 'tools: read', 'tools must be a list of tool names'],
    ['tools: [read, bash]', 'model: " "', 'model must be a nonempty string'],
    ['tools: [read, bash]', 'tool: [read]', 'Unknown field: tool'],
    ['tools: [read, bash]', 'isolate: remote', 'isolate must be none or worktree'],
    ['tools: [read, bash]', 'summaries: never', 'summaries must be a boolean'],
    ['tools: [read, bash]', 'fast: yes', 'fast must be a boolean'],
    ['tools: [read, bash]', 'family: Not a family', 'family must be a family name'],
    ['tools: [read, bash]', 'fallback: [a/b, " "]', 'fallback must be a model or a list'],
    ['tools: [read, bash]', 'fallback: 42', 'fallback must be a model or a list'],
    ['Original instructions', '', 'Instructions are required'],
  ])
    expect(() => parseDefinition(definition().replace(from, to), 'test')).toThrow(error)
})

it('reads back every field it writes, and writes only the fields set', () => {
  const fields: DefinitionFields = {
    description: 'Reviews: code, "quotes" and #tags',
    model: 'provider/model',
    thinking: 'high',
    fallback: ['other/model:low'],
    family: 'code-review',
    tools: ['read', 'bash'],
    denyTools: ['write'],
    isolate: 'worktree',
    resident: false,
    fast: true,
    summaries: false,
  }
  const text = serializeDefinition(
    'helper',
    { ...fields, description: ` ${fields.description}\n` },
    '\nDo it.\n\n',
  )
  expect(parseDefinition(text, 'helper.md')).toEqual({
    name: 'helper',
    path: 'helper.md',
    instructions: 'Do it.',
    ...fields,
  })
  expect(serializeDefinition('scout', { description: 'Search' }, 'Search')).toBe(
    '---\nname: scout\ndescription: Search\n---\n\nSearch\n',
  )
})

it('reads a single fallback model as a list of one', () => {
  const text = '---\nname: helper\ndescription: Helps\nfallback: provider/model\n---\nDo it.\n'
  expect(parseDefinition(text, 'helper.md').fallback).toEqual(['provider/model'])
})

it('discovers model and thinking settings and reports unknown models', async () => {
  const repo = await directory(),
    home = await directory(),
    cwd = await directory()
  await mkdir(join(repo, 'agents'))
  const modelRuntime = await ModelRuntime.create()
  for (const [name, model, thinking] of [
    ['exact', 'anthropic/claude-opus-4-8', ''],
    ['suffix', 'anthropic/claude-opus-4-8:high', ''],
    ['explicit', 'anthropic/claude-opus-4-8:high', 'thinking: low\n'],
    ['unknown', 'anthropic/ultimate-nonexistent-model', ''],
    ['missing', 'ultimate-nonexistent-model', ''],
  ])
    await writeFile(
      join(repo, `agents/${name}.md`),
      definition(name)
        .replace('name: scout', `name: ${name}`)
        .replace('tools: [read, bash]', `model: ${model}\n${thinking}`),
    )
  new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
  const found = await discoverAgents(repo, cwd, home, modelRuntime)
  expect(found.definitions.find((agent) => agent.name === 'exact')?.model).toEqual({
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
  })
  expect(found.definitions.find((agent) => agent.name === 'suffix')?.thinking).toBe('high')
  expect(found.definitions.find((agent) => agent.name === 'explicit')?.thinking).toBe('low')
  expect(found.errors.find((file) => file.name === 'unknown')?.error).toContain(
    'model: Model "ultimate-nonexistent-model" not found for provider "anthropic". Using custom model id.',
  )
  expect(found.errors.find((file) => file.name === 'missing')?.error).toContain(
    'model: Model "ultimate-nonexistent-model" not found.',
  )
})
