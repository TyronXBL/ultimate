import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Automations } from '../../extensions/automations/server.ts'
import type { Automation } from '../../extensions/automations/types.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, until } from '../helpers.ts'
import { tracked, fixture, create, writeRun, call } from './automations-scripts-fixture.ts'

it('sweeps a crashed process pid file even when no automation record exists', async () => {
  const { app, folder, options } = await fixture()
  await app.close()
  tracked.server = undefined
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  const exited = new Promise<void>((done) => child.once('close', () => done()))
  try {
    await mkdir(folder('A999'), { recursive: true })
    await writeFile(join(folder('A999'), 'pid'), `${child.pid}\n`)
    tracked.server = await fauxServer(options)
    await exited
    expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    await expect(readFile(join(folder('A999'), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL')
    await exited
  }
})

it('commits a one-shot as done before termination and never starts it again on reopen', async () => {
  const { app, folder, options } = await fixture()
  const sub = await create(app)
  await writeRun(
    folder(sub.id),
    'trap "" TERM; echo started >> "$AUTOMATION_STATE/starts"; echo FIRE done; exec sleep 60',
  )
  await call(app, 'resume', sub.id)
  await until(
    async () =>
      (await app.harness.snapshot(Automations, context))!.automations[sub.id].script!.state ===
      'done',
  )
  expect((await app.harness.snapshot(Automations, context))!.automations[sub.id]).toMatchObject({
    enabled: false,
    fires: 1,
  })
  await app.close()
  tracked.server = undefined
  tracked.server = await fauxServer(options)
  expect(
    (await tracked.server.harness.snapshot(Automations, context))!.automations[sub.id],
  ).toMatchObject({
    enabled: false,
    fires: 1,
    script: { state: 'done' },
  })
  expect(await readFile(join(folder(sub.id), 'state/starts'), 'utf8')).toBe('started\n')
  await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('closes during a pending start without spawning a process after cleanup', async () => {
  const { app, folder } = await fixture()
  const sub = await create(app)
  await writeRun(folder(sub.id), 'echo $$ > "$AUTOMATION_STATE/started"; exec sleep 60')
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let held = false
  const original = app.harness.snapshot.bind(app.harness) as (
    ...args: unknown[]
  ) => Promise<unknown>
  // Snapshot is overloaded; preserve its API while holding this specific launch before its async file work.
  const snapshot = vi.spyOn(app.harness, 'snapshot').mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await original(...args)
    if (
      !held &&
      (args[0] as typeof Automations).definition.kind === Automations.definition.kind &&
      (result as { automations: Record<string, Automation> })?.automations[sub.id]?.script
        ?.state === 'running'
    ) {
      held = true
      entered.resolve()
      await resume.promise
    }
    return result
  }) as typeof app.harness.snapshot)
  try {
    const starting = call(app, 'resume', sub.id).then(
      () => '',
      (error: unknown) => String(error),
    )
    await entered.promise
    // Release invokes the same supervisor close callback synchronously, before full host shutdown awaits it.
    const releasing = app.extensions.released()
    const closing = app.close()
    resume.resolve()
    expect(await starting).toContain('supervisor is closing')
    await releasing
    await closing
    tracked.server = undefined
    await expect(readFile(join(folder(sub.id), 'pid'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(folder(sub.id), 'state/started'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    resume.resolve()
    snapshot.mockRestore()
  }
})
