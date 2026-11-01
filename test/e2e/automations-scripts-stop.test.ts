import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'
import { launchHandshake, Automations } from '../../extensions/automations/server.ts'
import { Exited } from '../../extensions/automations/refs.ts'
import type { Automation } from '../../extensions/automations/types.ts'
import { context } from '../../server/harness.ts'
import { eventHost, temp, until } from '../helpers.ts'
import { fixture, create, writeRun, call } from './automations-scripts-fixture.ts'

it('waits for a SIGTERM-ignoring script to die before stop returns and removes its pid file', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), "trap '' TERM; echo ready; exec sleep 60")
  const running = (await call(app, 'resume', sub.id)) as Automation
  await until(async () =>
    ((await call(app, 'log', sub.id)) as { text: string }).text.includes('ready'),
  )
  expect(Number(await readFile(join(folder(sub.id), 'pid'), 'utf8'))).toBe(running.script!.pid)
  await call(app, 'pause', sub.id)
  expect(() => process.kill(-running.script!.pid!, 0)).toThrow(
    expect.objectContaining({ code: 'ESRCH' }),
  )
  await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['pause', 'delete'])(
  'awaits %s of a fired one-shot during its termination grace period',
  async (action) => {
    const { app, folder } = await fixture()
    const sub = await create(app)
    await writeRun(folder(sub.id), 'trap "" TERM; echo FIRE done; exec sleep 60')
    await call(app, 'resume', sub.id)
    await until(
      async () =>
        (await app.harness.snapshot(Automations, context))!.automations[sub.id].script!.state ===
        'done',
    )
    const pid = Number(await readFile(join(folder(sub.id), 'pid'), 'utf8'))
    expect((await app.harness.snapshot(Automations, context))!.automations[sub.id]).toMatchObject({
      enabled: false,
      script: { state: 'done', pid },
    })
    expect(process.kill(-pid, 0)).toBe(true)
    await call(app, action, sub.id)
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = (await app.harness.snapshot(Automations, context))!.automations[sub.id]
    // A fired one-shot stays done: pausing its lingering process is not a stop.
    const stopped = expect.objectContaining({
      enabled: false,
      script: expect.objectContaining({ state: 'done', exitedAt: expect.any(Number) }),
    })
    expect(saved).toEqual(action === 'delete' ? undefined : stopped)
    expect(saved?.script?.pid).toBeUndefined()
  },
)

it.each([false, true])(
  'launch handshake go=%s: EOF aborts; exec keeps the pid and gives the script empty stdin',
  async (go) => {
    const root = await temp('ultimate-automation-handshake-')
    await writeRun(
      root,
      'echo "$$"; if read -r value; then echo unexpected-input; else echo eof; fi',
    )
    const child = spawn('/bin/sh', ['-c', launchHandshake, join(root, 'run')], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => done({ code, signal }))
      },
    )
    child.stdin.end(go ? '\n' : undefined)
    expect(await exited).toEqual({ code: go ? 0 : 1, signal: null })
    expect(output).toBe(go ? `${child.pid}\neof\n` : '')
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  },
)

it('records the exit metadata and event for a successful done one-shot without a failure', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), "trap 'exit 0' TERM; echo FIRE done; while :; do :; done")
  await call(app, 'resume', sub.id)
  await until(
    async () =>
      !!(await app.harness.snapshot(Automations, context))!.automations[sub.id].script!.exitedAt,
  )
  const saved = (await app.harness.snapshot(Automations, context))!.automations[sub.id]
  expect(saved).toMatchObject({ enabled: false, fires: 1, script: { state: 'done', exitCode: 0 } })
  expect(saved.script?.pid).toBeUndefined()
  const events = await eventHost(() => app.harness, 'test').eventLog.recent({ events: [Exited] })
  expect(events.filter((event) => event.data.id === sub.id).map((event) => event.data)).toEqual([
    { id: sub.id, code: 0 },
  ])
  const agent = (await app.harness.conversation(
    sub.script!.conversationId as ConversationId,
    context,
  ))!
  expect(
    (await agent.context(context)).entries.filter((entry) => entry.kind === 'automations.failed'),
  ).toHaveLength(0)
})
