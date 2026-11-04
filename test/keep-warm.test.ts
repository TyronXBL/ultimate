import { expect, it } from 'vitest'
import {
  chipOf,
  due,
  failing,
  IDLE_STOP,
  LEAD,
  outcome,
  TTL,
  warmStep,
} from '../extensions/keep-warm/due.ts'
import type { WarmEvent } from '../extensions/keep-warm/due.ts'
import type { WarmDocState, WarmState } from '../extensions/keep-warm/refs.ts'
import * as keepWarm from '../extensions/keep-warm/server.ts'

const now = Date.parse('2026-10-24T12:00:00Z')
const minutes = (count: number) => count * 60_000

it('pings in the last minutes of the cache hour while the user was here recently', () => {
  expect(due({ now, lastRequest: now - LEAD, inputAt: now - minutes(70) })).toBe(true)
  expect(due({ now, lastRequest: now - minutes(59), inputAt: now - minutes(59) })).toBe(true)
})

it('waits while the cache is fresh and never pings a cold one', () => {
  expect(due({ now, lastRequest: now - minutes(30), inputAt: now - minutes(30) })).toBe(false)
  expect(due({ now, lastRequest: now - TTL, inputAt: now - minutes(61) })).toBe(false)
})

it('stops once the user has been away 8 hours, and without any input', () => {
  expect(due({ now, lastRequest: now - LEAD, inputAt: now - IDLE_STOP })).toBe(false)
  expect(due({ now, lastRequest: now - LEAD })).toBe(false)
  expect(due({ now, inputAt: now })).toBe(false)
})

it('does not retry after a failed ping until a newer request', () => {
  const lastRequest = now - LEAD
  const inputAt = now - minutes(70)
  expect(due({ now, lastRequest, inputAt, failedAfter: lastRequest + 1 })).toBe(false)
  expect(due({ now, lastRequest, inputAt, failedAfter: lastRequest - 1 })).toBe(true)
})

it('clears a failed ping once a cached @ultimate answer follows it', () => {
  const failedAt = now - minutes(300)
  expect(failing(failedAt, now - minutes(355))).toBe(true)
  expect(failing(failedAt, undefined)).toBe(true)
  expect(failing(failedAt, now - minutes(10))).toBe(false)
  expect(failing(undefined, now)).toBe(false)
})

it('counts only answers that read or wrote the current model’s cache', () => {
  const answer = (change: Record<string, unknown>) =>
    ({
      role: 'assistant',
      provider: 'claude-code',
      model: 'claude-opus-5-5',
      stopReason: 'stop',
      usage: { cacheRead: 500_000, cacheWrite: 2_000 },
      ...change,
    }) as unknown as Parameters<typeof keepWarm.cached>[0]
  expect(keepWarm.cached(answer({}), 'claude-opus-5-5')).toBe(true)
  expect(keepWarm.cached(answer({ stopReason: 'error' }), 'claude-opus-5-5')).toBe(false)
  expect(keepWarm.cached(answer({ model: 'claude-fable-5-1' }), 'claude-opus-5-5')).toBe(false)
  expect(keepWarm.cached(answer({ provider: 'openai-codex' }), 'claude-opus-5-5')).toBe(false)
  expect(
    keepWarm.cached(answer({ usage: { cacheRead: 0, cacheWrite: 0 } }), 'claude-opus-5-5'),
  ).toBe(false)
})

it('sends only while not paused and within the hour, checked right before the request', () => {
  expect(keepWarm.open(false, now - LEAD, now)).toBe(true)
  expect(keepWarm.open(true, now - LEAD, now)).toBe(false)
  expect(keepWarm.open(undefined, now - LEAD, now)).toBe(true)
  expect(keepWarm.open(false, now - TTL, now)).toBe(false)
})

it('leaves the switch to the user', () => {
  expect(keepWarm.userActions).toEqual(['set'])
})

const ping = (error?: string) => ({ at: now - minutes(5), model: 'm', ...(error ? { error } : {}) })

it('moves the document only through warmStep', () => {
  const at = now
  const rows: [string, WarmDocState, WarmEvent, boolean, WarmDocState][] = [
    // 89bccf4c, 6413693a: a claim records the attempt as interrupted and counts it, in one step.
    [
      'claims',
      { last: ping(), pings: 2 },
      { type: 'claim', at, model: 'm', previous: now - minutes(5) },
      true,
      { last: { at, model: 'm', error: 'interrupted' }, pings: 3 },
    ],
    [
      'claims the first',
      {},
      { type: 'claim', at, model: 'm' },
      true,
      { last: { at, model: 'm', error: 'interrupted' }, pings: 1 },
    ],
    // 89bccf4c: off, or another attempt recorded since the tick read, refuses the claim and changes nothing.
    ['refused when off', { off: true }, { type: 'claim', at, model: 'm' }, false, { off: true }],
    [
      'refused after another attempt',
      { last: ping() },
      { type: 'claim', at, model: 'm' },
      false,
      { last: ping() },
    ],
    [
      'records the outcome',
      { last: ping('interrupted'), pings: 1 },
      { type: 'record', ping: ping() },
      true,
      { last: ping(), pings: 1 },
    ],
    ['notes the input', {}, { type: 'input', at }, true, { inputAt: at }],
    ['turns off', { inputAt: at }, { type: 'switch', on: false }, true, { inputAt: at, off: true }],
    ['turns on', { off: true }, { type: 'switch', on: true }, true, {}],
  ]
  for (const [name, from, event, applied, expected] of rows) {
    const doc = structuredClone(from)
    expect({ name, applied: warmStep(doc, event), doc }).toEqual({ name, applied, doc: expected })
  }
})

it('reads a ping and the chip as states', () => {
  expect([undefined, 'interrupted', 'HTTP 500'].map((error) => outcome(ping(error)))).toEqual([
    'succeeded',
    'failed',
    'failed',
  ])
  const chip = (state: Partial<WarmState>) => chipOf({ on: true, pings: 0, ...state }, now)
  const lastRequest = now - minutes(10)
  expect(chip({ lastRequest })).toBe('warm')
  expect(chip({ lastRequest: now - TTL })).toBe('cold')
  expect(chip({ lastRequest, on: false })).toBe('off')
  // Off wins over a failed ping: no pings run, so the chip is not red.
  expect(
    chip({ lastRequest, on: false, last: { ...ping('HTTP 500'), at: now - minutes(5) } }),
  ).toBe('off')
  // 6413693a: a crashed attempt counts as a failure.
  expect(chip({ lastRequest, last: { ...ping('interrupted'), at: now - minutes(5) } })).toBe(
    'failing',
  )
  expect(chip({ lastRequest, last: { ...ping(), at: now - minutes(5) } })).toBe('warm')
  // 5f134f69: a cached answer after the failed ping clears the red chip.
  expect(chip({ lastRequest: now - minutes(1), last: ping('HTTP 500') })).toBe('warm')
})
