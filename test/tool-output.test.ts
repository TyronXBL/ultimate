import { expect, it, vi } from 'vitest'
import { truncateToolOutput } from '../lib/tool-output.ts'

const LIMIT = 50 * 1024
const NOTICE = '\n[Output truncated to 50KB / 2000 lines.]'

// #273712: a line over the limit was trimmed one character at a time, each step measuring the whole rest: 149,000
// measurements for the line below, and minutes of a blocked host for one 5 MiB line (minified JSON through
// `web_fetch`). The count is what the test holds; a time limit never fires inside synchronous code.
it.each([
  ['one-byte characters', 'x', 0],
  ['two-byte characters, which leave a byte over', 'ü', 1],
])(
  'cuts one long line of %s to its longest fitting start in a few measurements',
  (_, character, spare) => {
    const measured = vi.spyOn(Buffer, 'byteLength')
    const output = truncateToolOutput(character.repeat(200_000))
    expect(measured.mock.calls.length).toBeLessThan(100)
    measured.mockRestore()
    expect(output.endsWith(NOTICE)).toBe(true)
    expect(Buffer.byteLength(output)).toBe(LIMIT - spare)
    expect(output.slice(0, -NOTICE.length)).toMatch(new RegExp(`^${character}+$`))
  },
)
