import { expect, it } from 'vitest'
import { parseDefinition, serializeDefinition } from '../lib/agents.ts'

const definition = (fields: string) =>
  `---\nname: helper\ndescription: Helps\n${fields}\n---\nDo the work.\n`

it('validates definition family and fallback fields and preserves valid values', () => {
  expect(
    parseDefinition(
      definition('family: code-review\nfallback: [provider/model, other/model:high]'),
      'helper.md',
    ),
  ).toMatchObject({ family: 'code-review', fallback: ['provider/model', 'other/model:high'] })

  for (const [field, value, error] of [
    ['family', 'Not a family', 'family must be a family name'],
    ['fallback', '[provider/model, " "]', 'fallback must be a model or a list of models'],
    ['fallback', '42', 'fallback must be a model or a list of models'],
  ])
    expect(() => parseDefinition(definition(`${field}: ${value}`), 'helper.md')).toThrow(error)
})

it('serializes explicit false flags and rejects malformed agent names when parsing', () => {
  const text = serializeDefinition(
    'helper',
    { description: 'Helps', resident: false, summaries: false },
    'Do the work.',
  )
  expect(text).toContain('resident: false')
  expect(text).toContain('summaries: false')
  expect(() =>
    parseDefinition(definition('').replace('name: helper', 'name: helper!'), 'helper.md'),
  ).toThrow('name must be a nonempty identifier')
})
