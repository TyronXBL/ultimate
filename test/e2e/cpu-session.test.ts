import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import {
  resumeProcesses,
  sessionIdentities,
  sessionCpuMs,
  sessionMarked,
  sessionMembers,
  signalSession,
  stopProcesses,
} from '../../lib/cpu.ts'
import { until } from '../helpers.ts'

/** A process's state letter (`R`, `S`, `T` for stopped, …); empty once it is gone. */
const stateOf = (pid: number) =>
  readFile(`/proc/${pid}/stat`, 'utf8').then(
    (stat) => stat.slice(stat.lastIndexOf(')') + 2)[0],
    // Ended since it was listed.
    () => '',
  )

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

    // Recorded first, then stopped, as the background task does.
    const stopped = await sessionIdentities(sid)
    stopProcesses(stopped)
    await sleep(200)
    expect(await coresOver(sid, 1000)).toBeLessThan(0.05)
    resumeProcesses(stopped)
    expect(await coresOver(sid, 1500)).toBeGreaterThan(0.5)

    // Its leader killed from outside while paused (review of #227574): nothing of it stays stopped. What survives runs
    // again by its recorded identity; a group orphaned by the kill may instead end on the kernel's own SIGHUP.
    const again = await sessionIdentities(sid)
    stopProcesses(again)
    process.kill(sid, 'SIGKILL')
    await until(async () => !(await sessionMembers(sid)).includes(sid))
    resumeProcesses(again)
    await until(async () =>
      (await Promise.all((await sessionMembers(sid)).map(stateOf))).every((state) => state !== 'T'),
    )

    await signalSession(sid, 'SIGTERM')
    await until(async () => (await sessionMembers(sid)).length === 0, 5000)
  } finally {
    await signalSession(sid, 'SIGKILL')
  }
})
