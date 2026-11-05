import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { doneText, fireText, trimLog } from '../extensions/automations/types.ts'
import { scriptStep } from '../extensions/automations/state.ts'
import type { Script, ScriptEvent } from '../extensions/automations/state.ts'
import type { Automation } from '../extensions/automations/types.ts'
import { context } from '../server/harness.ts'
import { fauxServer, removeTemp, temp, until } from './helpers.ts'

const homes: string[] = []
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const home of homes.splice(0)) await removeTemp(home)
})

it('accepts loose FIRE text, including JSON and an empty payload, only on stdout', () => {
  expect(fireText('FIRE done', true)).toBe('done')
  expect(fireText('FIRE {"status":"ok"}', true)).toBe('{"status":"ok"}')
  expect(fireText('FIRE', true)).toBe('')
  expect(fireText('FIRE\tfinished', true)).toBe('finished')
  for (const text of ['progress', 'FIREWORKS', ' FIRE done', 'fire done'])
    expect(fireText(text, true)).toBeUndefined()
  expect(fireText('FIRE not a notification', false)).toBeUndefined()
})

it('reads DONE with optional text only on stdout', () => {
  expect(doneText('DONE', true)).toBe('')
  expect(doneText('DONE all merged', true)).toBe('all merged')
  for (const text of ['DONEZO', 'done', ' DONE']) expect(doneText(text, true)).toBeUndefined()
  expect(doneText('DONE', false)).toBeUndefined()
})

it('retains the newest output within both line and byte limits', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join('')
  const trimmed = trimLog(text)
  expect(trimmed.split('\n')).toHaveLength(2001)
  expect(trimmed.startsWith('line 1000\n')).toBe(true)
  expect(trimmed.endsWith('line 2999\n')).toBe(true)
  const long = trimLog('x'.repeat(300 * 1024) + '\nend\n')
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(256 * 1024)
  expect(long.endsWith('\nend\n')).toBe(true)
  expect(trimLog('progress\n')).toBe('progress\n')
})

// A project extension outside the clone cannot import api.ts; the token is its name, which is all `want` needs.
const consumer = `
import { defineExtension } from '@earendil-works/pi-durable'
const Automations = { name: 'automations' }
export default () => defineExtension({ name: 'prs' })
export const actions = {
  call: async ({ method, id }, { host }) => {
    const automations = host.want(Automations)
    if (!automations) return 'missing'
    try { return await automations[method](id) } catch (error) { return String(error) }
  },
}`

it('lets a project extension read, pause and resume an automation through the service', async () => {
  const home = await temp('ultimate-automations-service-')
  homes.push(home)
  const projectRoot = join(home, 'project')
  const definitions = join(home, '.ultimate/agents')
  await mkdir(definitions, { recursive: true })
  await writeFile(
    join(definitions, 'watcher.md'),
    '---\nname: watcher\ndescription: Test\nmodel: faux/faux-1\ntools: []\n---\nShort.\n',
  )
  const folder = join(projectRoot, '.ultimate/extensions/prs')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server.ts'), consumer)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const caller = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const sub = (await server.extensions.invoke(
    'automations',
    'create',
    { name: 'Watch', ask: 'Watch ship/* PRs', once: false },
    new AbortController().signal,
    caller.id,
  )) as Automation
  await until(() => !!server.extensions.action('prs', 'call'))
  const call = (method: string, id = sub.id) =>
    server.extensions.invoke('prs', 'call', { method, id }, new AbortController().signal)

  expect(await call('status')).toMatchObject({
    id: sub.id,
    alive: false,
    script: { state: 'writing' },
  })
  expect(await call('pause')).toMatchObject({
    id: sub.id,
    enabled: false,
    script: { state: 'stopped' },
  })
  // Resume checks the executable before it changes anything: the automation stays stopped.
  expect(await call('resume')).toContain('Missing or non-executable')
  expect(await call('status')).toMatchObject({ script: { state: 'stopped' } })
  expect(await call('status', 'A99')).toBe('Error: Unknown automation: A99')
  expect(await call('status', 'nope')).toBe('Error: Unknown automation: nope')
  expect(await call('status', 'Not/A slug')).toBe(
    'Error: id must be A<n> or a project automation slug',
  )
  expect(server.extensions.catalogue().apis.find((api) => api.name === 'automations')).toEqual({
    name: 'automations',
    provider: 'automations',
    needs: [],
    wants: ['goal', 'prs'],
  })
})

it('steps a script through its lifecycle, with `enabled` following its state', () => {
  const HOUR = 3600_000
  const base = { ask: 'watch', once: false, conversationId: 7, failures: 0 }
  const up = { pid: 41, startedAt: 1000 }
  const ended = { exitedAt: 1500, exitCode: 1 }
  const fail = {
    type: 'exit',
    at: 2000,
    code: 1,
    stopped: false,
    said: false,
    reason: 'boom',
  } as const
  const at = (state: Script['state'], rest: object = {}) => ({ ...base, state, ...rest }) as Script
  const rows: [string, Script, ScriptEvent, Script, boolean][] = [
    // Resume starts it from any state, keeps the old pid for the launch to sweep and forgets the old exit and error.
    [
      'resume after a failure',
      at('failed', { error: 'x', exit: ended }),
      { type: 'resume' },
      at('running'),
      true,
    ],
    [
      'resume keeps the pid to sweep',
      at('stopped', { process: up }),
      { type: 'resume' },
      at('running', { process: up }),
      true,
    ],
    [
      'resume a fired one-shot',
      at('done', { exit: ended }),
      { type: 'resume' },
      at('running'),
      true,
    ],
    // Pause keeps the pid until the exit is recorded, and a fired one-shot stays done.
    [
      'pause',
      at('running', { process: up }),
      { type: 'pause' },
      at('stopped', { process: up }),
      false,
    ],
    [
      'pause keeps a fired one-shot done',
      at('done', { process: up }),
      { type: 'pause' },
      at('done', { process: up }),
      false,
    ],
    [
      'pause keeps what failed',
      at('failed', { error: 'x' }),
      { type: 'pause' },
      at('stopped', { error: 'x' }),
      false,
    ],
    [
      'the fire cap pauses with its reason',
      at('running', { process: up }),
      { type: 'pause', reason: 'cap' },
      at('stopped', { error: 'cap', process: up }),
      false,
    ],
    // A changed ask sends the watcher back to writing; an edit while paused is written too, so it is enabled.
    [
      'rewrite while running',
      at('running', { process: up }),
      { type: 'write' },
      at('writing', { process: up }),
      true,
    ],
    [
      'rewrite after a failure',
      at('failed', { error: 'x', exit: ended }),
      { type: 'write' },
      at('writing', { exit: ended }),
      true,
    ],
    [
      'escalate',
      at('investigating', { error: 'x', exit: ended }),
      { type: 'escalate', reason: 'no' },
      at('failed', { error: 'no', exit: ended }),
      false,
    ],
    // The process starts, prints, and a FIRE counts as it doing its job.
    [
      'start records the process',
      at('running'),
      { type: 'start', at: 1000, pid: 41 },
      at('running', { process: up }),
      true,
    ],
    [
      'a start after a pause changes nothing',
      at('stopped'),
      { type: 'start', at: 1000, pid: 41 },
      at('stopped'),
      false,
    ],
    [
      'output',
      at('running', { failures: 2, process: up }),
      { type: 'output', at: 1200, fire: false },
      at('running', { failures: 2, process: { ...up, lastOutputAt: 1200 } }),
      true,
    ],
    [
      'a FIRE resets the failures',
      at('running', { failures: 2, process: up }),
      { type: 'output', at: 1200, fire: true },
      at('running', { process: { ...up, lastOutputAt: 1200 } }),
      true,
    ],
    [
      'a one-shot is done once fired',
      at('running', { once: true, process: up }),
      { type: 'fired' },
      at('done', { once: true, process: up }),
      false,
    ],
    [
      'a recurring script keeps running when fired',
      at('running', { process: up }),
      { type: 'fired' },
      at('running', { process: up }),
      true,
    ],
    // Exits: an unplanned one is investigated, the third in a row escalates, an hour of running starts the count again.
    [
      'an unplanned exit',
      at('running', { process: up }),
      fail,
      at('investigating', { failures: 1, error: 'boom', exit: { exitedAt: 2000, exitCode: 1 } }),
      true,
    ],
    [
      'an exit by signal has no code',
      at('running', { process: up }),
      { ...fail, code: null },
      at('investigating', { failures: 1, error: 'boom', exit: { exitedAt: 2000 } }),
      true,
    ],
    [
      'the third failure in a row fails the script',
      at('running', { failures: 2, process: up }),
      fail,
      at('failed', {
        failures: 3,
        error: 'Failed 3 times in a row: boom',
        exit: { exitedAt: 2000, exitCode: 1 },
      }),
      false,
    ],
    [
      'an hour of running starts a new count',
      at('running', { failures: 2, process: up }),
      { ...fail, at: 1000 + HOUR },
      at('investigating', {
        failures: 1,
        error: 'boom',
        exit: { exitedAt: 1000 + HOUR, exitCode: 1 },
      }),
      true,
    ],
    [
      'a recurring DONE with exit 0 stops it',
      at('running', { process: up }),
      { ...fail, code: 0, said: true },
      at('stopped', { exit: { exitedAt: 2000, exitCode: 0 } }),
      false,
    ],
    [
      'a one-shot that printed DONE still failed',
      at('running', { once: true, process: up }),
      { ...fail, code: 0, said: true },
      at('investigating', {
        once: true,
        failures: 1,
        error: 'boom',
        exit: { exitedAt: 2000, exitCode: 0 },
      }),
      true,
    ],
    [
      'a stop while running is not a failure',
      at('running', { process: up }),
      { ...fail, stopped: true },
      at('running'),
      true,
    ],
    [
      'the exit of a paused process is recorded',
      at('stopped', { process: up }),
      { ...fail, stopped: true },
      at('stopped', { exit: { exitedAt: 2000, exitCode: 1 } }),
      false,
    ],
    [
      'the exit of a fired one-shot is not a failure',
      at('done', { once: true, process: up }),
      { ...fail, code: 0 },
      at('done', { once: true, exit: { exitedAt: 2000, exitCode: 0 } }),
      false,
    ],
    [
      'an exit nothing expects changes nothing',
      at('writing', { process: up }),
      fail,
      at('writing', { process: up }),
      true,
    ],
    // The manifest and edits change what the script is told, never its state.
    [
      'a manifest replaces what the script is told',
      at('failed', { error: 'x', secrets: ['A'] }),
      { type: 'manifest', ask: 'new', once: true, to: '@ultimate' },
      at('failed', { error: 'x', ask: 'new', once: true, to: '@ultimate' }),
      false,
    ],
    [
      'an edit changes only what it names',
      at('running'),
      { type: 'edit', once: true },
      at('running', { once: true }),
      true,
    ],
  ]
  for (const [name, from, event, script, enabled] of rows)
    expect({ name, ...scriptStep(from, event) }).toStrictEqual({ name, script, enabled })
})
