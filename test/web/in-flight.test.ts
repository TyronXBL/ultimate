import { expect, it } from 'vitest'
import { listedInFlight } from '../../extensions/sidebar/listed.ts'

const asked = { id: 5, from: 12, to: 'user' as const, reply: true, state: 'delivered' }

// A branch asked the user and landed straight away: it folded into Landed and its question was lost.
it('keeps a landed branch in flight while its question waits on the user', () => {
  expect(listedInFlight(12, false, [asked])).toBe(true)
  expect(listedInFlight(12, false, [{ ...asked, state: 'answered' }])).toBe(false)
  expect(listedInFlight(12, false, [{ ...asked, state: 'dismissed' }])).toBe(false)
  expect(listedInFlight(12, false, [{ ...asked, from: 13 }])).toBe(false)
  expect(listedInFlight(12, true, [])).toBe(true)
})
