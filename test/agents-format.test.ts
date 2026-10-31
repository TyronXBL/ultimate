import { expect, it } from 'vitest'
import { parseDefinition, serializeDefinition } from '../lib/agents.ts'
import type { DefinitionFields } from '../lib/agents.ts'

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

it('reads a single fallback model as a list of one', () => {
  const text = '---\nname: helper\ndescription: Helps\nfallback: provider/model\n---\nDo it.\n'
  expect(parseDefinition(text, 'helper.md').fallback).toEqual(['provider/model'])
})
