import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { definitionRuns, mergeFamilies, parseFamilies, refOf } from '../lib/families.ts'
import { readFamilies, readFamilyLayers, writeFamilies } from '../lib/families-settings.ts'
import { temp } from './helpers.ts'

const families = (value: unknown, project?: unknown) =>
  mergeFamilies(parseFamilies(value), parseFamilies(project))

it('runs a definition on its pin, else its family, else the default family', () => {
  const config = families({
    families: {
      default: { model: 'acme/main' },
      fast: { model: 'acme/quick' },
      local: { model: 'vllm/current', thinking: 'low' },
    },
    // An agent's family lives in its definition: an old settings assignment no longer moves it.
    assign: { 'agent/worker': 'local' },
  })
  const pin = { provider: 'acme', modelId: 'big' }
  expect(definitionRuns({ family: 'fast' }, config)).toEqual({
    family: 'fast',
    model: { provider: 'acme', modelId: 'quick' },
    via: 'family',
  })
  expect(definitionRuns({ model: pin, family: 'fast' }, config)).toEqual({
    model: pin,
    via: 'pin',
  })
  // The family's thinking applies unless the definition sets its own.
  expect(definitionRuns({ family: 'local' }, config).thinking).toBe('low')
  expect(definitionRuns({ family: 'local', thinking: 'max' }, config).thinking).toBe('max')
  // The default family runs the parent's model; an unknown family falls back to it.
  expect(definitionRuns({}, config)).toEqual({ family: 'default', via: 'family' })
  expect(definitionRuns({ family: 'gone' }, config)).toEqual({
    family: 'default',
    via: 'family',
  })
})

it('merges the project over the user over the built-ins, field by field', () => {
  const config = families(
    { families: { tiny: { model: 'acme/mini' }, local: { model: 'vllm/current' } } },
    { families: { tiny: { thinking: 'high', color: 'teal' } }, assign: { summaries: 'local' } },
  )
  expect(config.families.tiny).toEqual({ model: 'acme/mini', thinking: 'high', color: 'teal' })
  expect(config.families.local.model).toBe('vllm/current')
  expect(config.families.local.color).toBeTruthy()
  expect(config.assign).toEqual({ summaries: 'local' })
})

it.each([
  ['a list', [], 'modelFamilies must be an object'],
  ['null families', { families: null }, 'modelFamilies.families must be an object'],
  ['a list of families', { families: [] }, 'modelFamilies.families must be an object'],
  ['an uppercase name', { families: { Bad: {} } }, 'families.Bad: lowercase letters'],
  ['punctuation after a name', { families: { 'fast!!': {} } }, 'families.fast!!: lowercase'],
  ['a name over 24 characters', { families: { ['a'.repeat(25)]: {} } }, 'lowercase'],
  ['a spec that is no object', { families: { fast: 'acme/x' } }, 'families.fast must be an object'],
  ['a model without provider', { families: { fast: { model: '/x' } } }, 'fast.model must be'],
  ['a model with a space', { families: { fast: { model: 'acme/x y' } } }, 'fast.model must be'],
  ['a provider with a space', { families: { fast: { model: 'my acme/x' } } }, 'model must be'],
  ['a model that is no string', { families: { fast: { model: 1 } } }, 'fast.model must be'],
  ['an unknown thinking level', { families: { fast: { thinking: 'huge' } } }, 'one of off,'],
  ['a thinking level that is no string', { families: { fast: { thinking: 1 } } }, 'thinking'],
  ['an unknown color', { families: { fast: { color: 'red' } } }, 'color must be one of sky,'],
  ['assign that is no object', { assign: 'fast' }, 'modelFamilies.assign must be an object'],
  ['assign to a bad name', { assign: { summaries: 'Fast' } }, 'assign.summaries must be a family'],
  ['assign to a non-string', { assign: { summaries: 1 } }, 'assign.summaries must be a family'],
])('rejects a modelFamilies setting with %s, naming the field', (_, value, error) => {
  expect(() => parseFamilies(value)).toThrow(error)
})

it('reads a model reference only with a provider and an id', () => {
  expect(refOf('acme/org/big')).toEqual({ provider: 'acme', modelId: 'org/big' })
  expect(refOf('/big')).toBeUndefined()
  expect(refOf('big')).toBeUndefined()
  expect(refOf(undefined)).toBeUndefined()
})

it("keeps each project's families and starts a project without its own from the ones saved last", async () => {
  const userHome = await temp('ultimate-families-')
  const [a, b, c] = ['a', 'b', 'c'].map((name) => join(userHome, name))
  for (const root of [a, b, c]) await mkdir(root)
  const tiny = async (root: string) =>
    (await readFamilyLayers(userHome, root, {})).from +
    ' ' +
    (await readFamilies(userHome, root, {})).families.tiny.model
  expect(await tiny(a)).toBe('builtin openai-codex/gpt-6-luna')
  await writeFamilies(userHome, a, { families: { tiny: { model: 'vllm/a' } } })
  await writeFamilies(userHome, b, { families: { tiny: { model: 'vllm/b' } } })
  // Each keeps its own; a project that never saved starts from the last save, b's.
  expect(await tiny(a)).toBe('project vllm/a')
  expect(await tiny(b)).toBe('project vllm/b')
  expect(await tiny(c)).toBe('recent vllm/b')
  // The project's team settings apply over its own families.
  const team = { modelFamilies: { families: { tiny: { model: 'acme/team' } } } }
  expect((await readFamilies(userHome, a, team)).families.tiny.model).toBe('acme/team')
})
