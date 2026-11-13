import { expect, it } from 'vitest'
import { truncateToolOutput } from '../lib/tool-output.ts'

const LIMIT = 50 * 1024
const NOTICE = '\n[Output truncated to 50KB / 2000 lines.]'

// #273712: a line over the limit was trimmed one character at a time, each step measuring the whole rest, so one
// megabyte-long line (minified JSON through `web_fetch`) took seconds and five took minutes of a blocked host.
// With that back, this test runs into its timeout.
it.each([
  ['one-byte characters', 'x', 0],
  ['two-byte characters, which leave a byte over', 'ü', 1],
])('keeps the longest fitting start of one megabyte-long line of %s', (_, character, spare) => {
  const output = truncateToolOutput(character.repeat(1_000_000))
  expect(output.endsWith(NOTICE)).toBe(true)
  expect(Buffer.byteLength(output)).toBe(LIMIT - spare)
  expect(output.slice(0, -NOTICE.length)).toMatch(new RegExp(`^${character}+$`))
})
