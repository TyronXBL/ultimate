import { expect, it } from 'vitest'
import { parseDefinition, serializeDefinition } from '../lib/agents.ts'
import type { DefinitionFields } from '../lib/agents.ts'

// test/subagents.test.ts proves the other fields; these are the ones only this file checks.
const definition = (fields: string) =>
  `---\nname: helper\ndescription: Helps\n${fields}\n---\nDo the work.\n`

it('keeps family, fallback, denyTools and flags, and rejects malformed ones', () => {
  expect(
    parseDefinition(
      definition(
        'family: code-review\nfallback: [provider/model, other/model:high]\ndenyTools: [bash]\nresident: true\nfast: false',
      ),
      'helper.md',
    ),
  ).toMatchObject({
    family: 'code-review',
    fallback: ['provider/model', 'other/model:high'],
    denyTools: ['bash'],
    resident: true,
    fast: false,
  })
  expect(parseDefinition(definition('fallback: provider/model'), 'helper.md').fallback).toEqual([
    'provider/model',
  ])

  for (const [field, value, error] of [
    ['family', 'Not a family', 'family must be a family name'],
    ['fallback', '[provider/model, " "]', 'fallback must be a model or a list of models'],
    ['fallback', '42', 'fallback must be a model or a list of models'],
    ['denyTools', 'bash', 'denyTools must be a list of tool names'],
    ['fast', 'yes', 'fast must be a boolean'],
  ])
    expect(() => parseDefinition(definition(`${field}: ${value}`), 'helper.md')).toThrow(error)
})

it('reads back every field it writes', () => {
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
})
