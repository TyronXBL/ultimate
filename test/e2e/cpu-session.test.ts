import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { sessionCpuMs, sessionMarked, sessionMembers, signalSession } from '../../lib/cpu.ts'
import { until } from '../helpers.ts'

/** Cores the session used over `ms`. */
async function coresOver(sid: number, ms: number) {
  const before = (await sessionCpuMs(sid))!
  const start = performance.now()
  await sleep(ms)
  return ((await sessionCpuMs(sid))! - before) / (performance.now() - start)
}

// #227574: two Playwright audits ran as `(timeout 900 node … &); timeout 1100 node …` from bash. `timeout` gives each
// a process group of its own, so the queue measures, pauses and stops by session, which only `setsid` leaves.
it('measures, pauses, resumes and stops a whole session, its timeout subgroups and a job sent away with & included', async () => {
  const id = `cpu-session-${process.pid}`
  const loop = 'timeout 60 bash -c "while :; do :; done"'
  const shell = spawn('bash', ['-c', `(${loop} &); ${loop}`], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ULTIMATE_BASH_CALL: id },
  })
  const sid = shell.pid!
  try {
    await until(async () => (await sessionMarked(`ULTIMATE_BASH_CALL=${id}`)) === sid)
    // Both loops and both `timeout`s: the shell's own group does not hold them all.
    await until(async () => (await sessionMembers(sid)).length >= 4)
    expect(await coresOver(sid, 1500)).toBeGreaterThan(0.5)

    await signalSession(sid, 'SIGSTOP')
    await sleep(200)
    expect(await coresOver(sid, 1000)).toBeLessThan(0.05)

    await signalSession(sid, 'SIGCONT')
    expect(await coresOver(sid, 1500)).toBeGreaterThan(0.5)

    await signalSession(sid, 'SIGTERM')
    await until(async () => (await sessionMembers(sid)).length === 0, 5000)
  } finally {
    await signalSession(sid, 'SIGKILL')
  }
})
