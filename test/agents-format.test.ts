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

it('discovers an edited or added definition on the next call, even within the same instant', async () => {
  const repo = await directory(),
    home = await directory(),
    cwd = await directory()
  await mkdir(join(repo, 'agents'))
  const modelRuntime = await ModelRuntime.create()
  const described = async () =>
    (await discoverAgents(repo, cwd, home, modelRuntime)).definitions.map((agent) => [
      agent.name,
      agent.instructions,
    ])
  await writeFile(join(repo, 'agents/scout.md'), definition('Look around'))
  expect(await described()).toEqual([['scout', 'Look around']])
  // Same length, so neither the size nor a coarse modification time tells the edit apart.
  await writeFile(join(repo, 'agents/scout.md'), definition('Look aroune'))
  expect(await described()).toEqual([['scout', 'Look aroune']])
  await writeFile(
    join(repo, 'agents/worker.md'),
    definition('Build it').replace('name: scout', 'name: worker'),
  )
  expect(await described()).toEqual([
    ['scout', 'Look aroune'],
    ['worker', 'Build it'],
  ])
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

it('extends an earlier definition with an addTools overlay and refuses a tools list', async () => {
  const repo = await directory(),
    home = await directory(),
    cwd = await directory()
  await mkdir(join(repo, 'agents'))
  await mkdir(join(home, '.ultimate/agents'), { recursive: true })
  await mkdir(join(cwd, '.ultimate/agents'), { recursive: true })
  const modelRuntime = await ModelRuntime.create()
  await writeFile(join(repo, 'agents/scout.md'), definition())
  await writeFile(
    join(repo, 'agents/open.md'),
    definition().replace('name: scout', 'name: open').replace('tools: [read, bash]\n', ''),
  )
  await writeFile(
    join(home, '.ultimate/agents/scout.md'),
    '---\nname: scout\naddTools: [write, read]\n---\n',
  )
  await writeFile(
    join(cwd, '.ultimate/agents/scout.md'),
    '---\nname: scout\naddTools: [laravel]\n---\n\nUse laravel for the database.\n',
  )
  await writeFile(
    join(cwd, '.ultimate/agents/open.md'),
    '---\nname: open\naddTools: [laravel]\n---\n',
  )
  for (const [name, text] of [
    ['listed', '---\nname: scout\naddTools: [x]\ntools: [read]\n---\n'],
    ['unknown', '---\nname: scout\naddTools: []\ncolour: red\n---\n'],
    ['orphan', '---\nname: nobody\naddTools: [x]\n---\n'],
  ])
    await writeFile(join(cwd, `.ultimate/agents/${name}.md`), text)
  new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
  const found = await discoverAgents(repo, cwd, home, modelRuntime)
  const scout = found.definitions.find((agent) => agent.name === 'scout')!
  expect(scout).toMatchObject({
    source: 'builtin',
    path: join(repo, 'agents/scout.md'),
    tools: ['read', 'bash', 'write', 'laravel'],
    instructions: `Original instructions\n\n## Project additions\n\nUse laravel for the database.`,
    overlays: [join(home, '.ultimate/agents/scout.md'), join(cwd, '.ultimate/agents/scout.md')],
  })
  // A definition that inherits every tool stays without a list.
  expect(found.definitions.find((agent) => agent.name === 'open')?.tools).toBeUndefined()
  expect(Object.fromEntries(found.errors.map((file) => [file.name, file.error]))).toEqual({
    listed: expect.stringContaining('adds tools with addTools, not tools'),
    unknown: expect.stringContaining('Unknown field: colour'),
    orphan: expect.stringContaining('needs an earlier definition named nobody'),
  })
  expect(found.replaced).toEqual([])
})
it('lets an overlay override settings such as model and thinking', async () => {
  const repo = await directory(),
    home = await directory(),
    cwd = await directory()
  await mkdir(join(repo, 'agents'))
  await mkdir(join(cwd, '.ultimate/agents'), { recursive: true })
  const modelRuntime = await ModelRuntime.create()
  await writeFile(join(repo, 'agents/scout.md'), definition())
  // An empty addTools marks a settings-only overlay.
  await writeFile(
    join(cwd, '.ultimate/agents/scout.md'),
    '---\nname: scout\nmodel: anthropic/claude-opus-4-8\nthinking: high\nfast: true\ndescription: Our scout\naddTools: []\n---\n',
  )
  new ProjectTrustStore(join(home, '.ultimate')).set(cwd, true)
  const found = await discoverAgents(repo, cwd, home, modelRuntime)
  expect(found.definitions.find((agent) => agent.name === 'scout')).toMatchObject({
    source: 'builtin',
    description: 'Our scout',
    model: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
    thinking: 'high',
    fast: true,
    tools: ['read', 'bash'],
    instructions: 'Original instructions',
  })
  expect(found.errors).toEqual([])
  expect(found.replaced).toEqual([])
})
