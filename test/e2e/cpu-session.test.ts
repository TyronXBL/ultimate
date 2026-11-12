import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import {
  continueSession,
  sessionCpuMs,
  sessionMarked,
  sessionMembers,
  signalSession,
  stopSession,
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
it('measures, pauses, resumes and stops a whole session, its timeout subgroups, a job sent away with & and a chain of processes', async () => {
  const id = `cpu-session-${process.pid}`
  const loop = 'timeout 60 bash -c "while :; do :; done"'
  // Each link starts its successor and ends: a pause that stopped only what it had seen could never catch up with it.
  const chain = 'step() { sleep 0.05; (step &); }; step'
  const shell = spawn('bash', ['-c', `(${loop} &); (${chain}) & ${loop}`], {
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

    expect(await stopSession(sid)).toBe(true)
    const paused = (await sessionMembers(sid)).toSorted((a, b) => a - b)
    await sleep(500)
    // Nothing runs and nothing new started: the chain stopped with the rest.
    expect(await coresOver(sid, 1000)).toBeLessThan(0.05)
    expect((await sessionMembers(sid)).toSorted((a, b) => a - b)).toEqual(paused)

    // Resumed by session, its leader killed from outside meanwhile (review of #227574): nothing stays stopped. A group
    // the kill orphans may instead end on the kernel's own SIGHUP.
    process.kill(sid, 'SIGKILL')
    await until(async () => !(await sessionMembers(sid)).includes(sid))
    await continueSession(sid)
    await until(async () =>
      (await Promise.all((await sessionMembers(sid)).map(stateOf))).every((state) => state !== 'T'),
    )
  } finally {
    // Stopped first, so no link of the chain starts another while the rest is killed.
    await stopSession(sid)
    await signalSession(sid, 'SIGKILL')
  }
})
