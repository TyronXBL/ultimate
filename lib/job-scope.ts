/**
 * Hard limits for a job (a background command, a heavy bash command): it runs in a transient systemd scope of its own
 * in `ultimate-jobs.slice`, under the user's systemd manager, with a memory limit and no swap, a CPU quota and a task
 * limit. Outside the host's cgroup (`ultimate.service`), a job that outgrows its limit is killed alone, instead of
 * driving every host in the service into reclaim at the service's soft cap (#231847: two `pnpm check` runs, load 30,
 * 2026-11-12; #261381). Linux with a systemd user manager only; elsewhere, CI included, jobs run without a scope.
 */
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, dirname } from 'node:path'
import { exec } from './exec.ts'

const SLICE = 'ultimate-jobs.slice'
/**
 * A job's memory limit in MiB: twice its estimated need (`commandNeedMiB`), at least 4 GiB. Admission plans with the
 * estimate; the limit only stops a runaway, so it leaves room for a real run above it (a full `pnpm check`, estimated
 * at 2200 MiB, peaked at 2.96 GiB on 2026-11-12, #261292).
 */
const jobMemoryMiB = (need: number) => Math.max(4096, 2 * need)

/** Its cgroup path, from the first line of `/proc/<pid>/cgroup` in cgroup v2 ("0::/path"). */
const cgroupOf = (text: string) => /^0::(\/.*)$/m.exec(text)?.[1]

/**
 * The jobs' slice as a cgroup path ("/user.slice/…/ultimate.slice/ultimate-jobs.slice"), learned from one scope started
 * in it, or undefined where scopes cannot start (no systemd user manager, not Linux). Looked up once per process.
 */
let probe: Promise<string | undefined> | undefined
const SCOPE = ['--user', '--scope', '--quiet', '--collect', `--slice=${SLICE}`]
export function jobsSlice() {
  probe ??=
    process.platform === 'linux'
      ? exec('systemd-run', [...SCOPE, '--', 'cat', '/proc/self/cgroup']).then(
          ({ stdout }) => {
            const scope = cgroupOf(stdout)
            return scope && dirname(scope)
          },
          // No systemd-run, or no user manager to reach (a container, CI, a login without one): no scopes.
          () => undefined,
        )
      : Promise.resolve(undefined)
  return probe
}

/** The unit this process runs in when it is a service ("ultimate.service"), for a job's scope to stop with it. */
async function ownService() {
  const own = cgroupOf(
    await readFile('/proc/self/cgroup', 'utf8').catch(
      // jobsSlice found a user manager, so this is Linux; a read failing here leaves the scope unbound.
      () => '',
    ),
  )
  const unit = own && basename(own)
  return unit?.endsWith('.service') && !unit.startsWith('user@') ? unit : undefined
}

/**
 * What a job's scope records in `usage` once its command ends: peak memory and CPU time in bytes and microseconds, and
 * how many of its processes the kernel's out-of-memory killer took. It runs in the scope, after the command, because the
 * scope's cgroup is gone once its last process is.
 */
const RECORD = `usage=$1; shift
"$@"; code=$?
cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)
echo "$(cat "$cg/memory.peak") $(sed -n 's/^usage_usec //p' "$cg/cpu.stat") $(sed -n 's/^oom_kill //p' "$cg/memory.events")" > "$usage"
exit $code`

/**
 * The argv that runs a job's command in a scope of its own, limited for a job needing `need` MiB and recording its use
 * in the file `usage` (`readUsage`): the command's own argv follows it. Undefined where scopes cannot start.
 */
export async function jobScope(need: number, usage: string) {
  if (!(await jobsSlice())) return undefined
  const service = await ownService()
  const limits = {
    MemoryMax: `${jobMemoryMiB(need)}M`,
    MemorySwapMax: '0',
    // One core stays free for the hosts, however many jobs the queue lets run.
    CPUQuota: `${Math.max(1, availableParallelism() - 1) * 100}%`,
    TasksMax: '4096',
    // The kernel kills the largest process; the scope lives on, so RECORD still writes what happened. With the default
    // policy (stop) systemd ends the whole scope, the recording with it.
    OOMPolicy: 'continue',
    // Stopped with the service like everything in it was, so no job outlives a stopped host uncounted.
    ...(service && { BindsTo: service, After: service }),
  }
  return [
    'systemd-run',
    ...SCOPE,
    ...Object.entries(limits).flatMap(([name, value]) => ['-p', `${name}=${value}`]),
    '--',
    '/bin/sh',
    '-c',
    RECORD,
    'record',
    usage,
  ]
}

/** What a job used: its peak memory and CPU time, its memory limit, and whether the kernel killed part of it for memory. */
export type JobUsage = { peakMiB: number; cpuSeconds: number; limitMiB: number; oomKilled: boolean }

/** The use a job's scope recorded in `usage`, for a job needing `need` MiB; undefined when it recorded none. */
export async function readUsage(usage: string, need: number): Promise<JobUsage | undefined> {
  const text = await readFile(usage, 'utf8').catch(
    // No scope (scopes cannot start here), or it was stopped before its command ended.
    () => '',
  )
  const [peak, usec, kills] = text.trim().split(' ').map(Number)
  if (![peak, usec, kills].every(Number.isFinite)) return undefined
  return {
    peakMiB: Math.round(peak / 2 ** 20),
    cpuSeconds: Math.round(usec / 1e6),
    limitMiB: jobMemoryMiB(need),
    oomKilled: kills > 0,
  }
}

/** Shell words for `argv`, single-quoted, to put a job scope in front of a command line. */
export const shellWords = (argv: string[]) =>
  argv.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ')

/** The line the report of a job the out-of-memory killer hit carries. */
export const describeOom = (usage: JobUsage) =>
  `The kernel killed part of it at its memory limit of ${usage.limitMiB} MiB (peak ${usage.peakMiB} MiB): the job ran in a systemd scope of its own, so nothing else was affected. Run it in smaller parts, or with fewer workers.`
