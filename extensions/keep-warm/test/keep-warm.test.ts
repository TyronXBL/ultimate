import { expect, it, vi } from 'vitest'
import { chipOf, due, failing, IDLE_STOP, LEAD, outcome, TTL, warmStep } from '../due.ts'
import type { WarmEvent } from '../due.ts'
import type { WarmDocState, WarmState } from '../refs.ts'
import * as keepWarm from '../server.ts'

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

it('warms Claude Code, and the Anthropic API only under long cache retention', () => {
  vi.stubEnv('PI_CACHE_RETENTION', undefined)
  expect(keepWarm.hourLong('claude-code')).toBe(true)
  expect(keepWarm.hourLong('anthropic')).toBe(false)
  vi.stubEnv('PI_CACHE_RETENTION', 'long')
  expect(keepWarm.hourLong('anthropic')).toBe(true)
  expect(keepWarm.hourLong('openai')).toBe(false)
  vi.unstubAllEnvs()
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
  const opus = { provider: 'claude-code', modelId: 'claude-opus-5-5' }
  expect(keepWarm.cached(answer({}), opus)).toBe(true)
  expect(keepWarm.cached(answer({ stopReason: 'error' }), opus)).toBe(false)
  expect(keepWarm.cached(answer({ model: 'claude-fable-5-1' }), opus)).toBe(false)
  expect(keepWarm.cached(answer({ provider: 'openai-codex' }), opus)).toBe(false)
  expect(keepWarm.cached(answer({}), { ...opus, provider: 'anthropic' })).toBe(false)
  expect(keepWarm.cached(answer({ usage: { cacheRead: 0, cacheWrite: 0 } }), opus)).toBe(false)
})

it('counts a ping only on the provider and model it warmed', () => {
  const ping = { at: now, provider: 'claude-code', model: 'claude-opus-5-5' }
  expect(keepWarm.lastOn(ping, { provider: 'claude-code', modelId: 'claude-opus-5-5' })).toBe(ping)
  expect(keepWarm.lastOn(ping, { provider: 'anthropic', modelId: 'claude-opus-5-5' })).toBe(
    undefined,
  )
  expect(keepWarm.lastOn(ping, { provider: 'claude-code', modelId: 'claude-fable-5-1' })).toBe(
    undefined,
  )
})

it('sends only while not paused and within the hour, checked right before the request', () => {
  expect(keepWarm.open(false, now - LEAD, now)).toBe(true)
  expect(keepWarm.open(true, now - LEAD, now)).toBe(false)
  expect(keepWarm.open(undefined, now - LEAD, now)).toBe(true)
  expect(keepWarm.open(false, now - TTL, now)).toBe(false)
})

const ping = (error?: string) => ({
  at: now - minutes(5),
  provider: 'p',
  model: 'm',
  ...(error ? { error } : {}),
})

it('moves the document only through warmStep', () => {
  const at = now
  const rows: [string, WarmDocState, WarmEvent, boolean, WarmDocState][] = [
    // 89bccf4c, 6413693a: a claim records the attempt as interrupted and counts it, in one step.
    [
      'claims',
      { last: ping(), pings: 2 },
      { type: 'claim', at, provider: 'p', model: 'm', previous: now - minutes(5) },
      true,
      { last: { at, provider: 'p', model: 'm', error: 'interrupted' }, pings: 3 },
    ],
    [
      'claims the first',
      {},
      { type: 'claim', at, provider: 'p', model: 'm' },
      true,
      { last: { at, provider: 'p', model: 'm', error: 'interrupted' }, pings: 1 },
    ],
    // 89bccf4c: off, or another attempt recorded since the tick read, refuses the claim and changes nothing.
    [
      'refused when off',
      { off: true },
      { type: 'claim', at, provider: 'p', model: 'm' },
      false,
      { off: true },
    ],
    [
      'refused after another attempt',
      { last: ping() },
      { type: 'claim', at, provider: 'p', model: 'm' },
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
