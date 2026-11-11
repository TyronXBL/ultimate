import { describe, expect, test } from 'vitest'
import { owners } from '../owners.ts'
import type { OwnerContext, Proc, Top } from '../owners.ts'

const home = '/home/me/.ultimate/projects'
const context: OwnerContext = {
  supervisors: new Map([
    [100, 'my-app'],
    [200, 'notes'],
  ]),
  homes: new Map([
    [`${home}/my-app-1a2b`, 'my-app'],
    [`${home}/notes-3c4d`, 'notes'],
  ]),
  roots: new Map([
    ['/srv/my-app', 'my-app'],
    ['/srv/notes', 'notes'],
  ]),
  jobs: new Map([[300, { job: 'my-app:background:7', label: 'pnpm check', conversation: 12 }]]),
}

/** A process: pid, its parent, its group, CPU in cores and RSS in MiB. */
const proc = (
  pid: number,
  ppid: number,
  pgid: number,
  cpu = 0,
  rssMiB = 10,
  name = 'node',
): Proc => ({
  pid,
  ppid,
  pgid,
  name,
  cpu,
  rssKiB: rssMiB * 1024,
  since: 1000 + pid,
})
const top = (cwd: string, ...argv: string[]): Top => ({ argv, cwd })

describe('owners', () => {
  // The machine as it looked on 2026-11-11 at 18:40: one queue job running, and test runs and audits from two
  // projects outside the queue, started from plain bash, filling the cores.
  const procs = [
    proc(1, 0, 1, 0, 10, 'systemd'),
    // my-app's host: its supervisor, server and helper share one group.
    proc(100, 1, 100, 0, 90),
    proc(101, 100, 100, 0.2, 480),
    proc(102, 101, 100, 0, 80),
    // notes' host.
    proc(200, 1, 200, 0, 90),
    proc(201, 200, 200, 0.1, 400),
    // The queue's job (#12's `pnpm check`) and a worker it started in a group of its own.
    proc(300, 101, 300, 0.9, 300),
    proc(301, 300, 301, 0.6, 200),
    // Outside the queue: #14's wrapper script in my-app with three vitest workers, and #22's audit in notes, which
    // started a Chromium of its own and outlived its bash (reparented to init).
    proc(400, 101, 400, 0.1, 20, 'bash'),
    proc(401, 400, 400, 1.9, 600),
    proc(402, 400, 400, 1.8, 600),
    proc(403, 400, 400, 1.7, 600),
    proc(500, 1, 500, 1.2, 150),
    proc(501, 500, 501, 0.8, 300, 'chromium'),
    // A preview of #15 with its own Chromium, and the host's idle browser-tool Chromium.
    proc(600, 101, 600, 0.05, 700),
    proc(601, 600, 601, 0, 250, 'chromium'),
    proc(700, 101, 700, 0, 600, 'chromium'),
    proc(701, 700, 700, 0, 100, 'chromium'),
    // An automation of my-app, and something no Ultimate started.
    proc(800, 101, 800, 0, 60),
    proc(900, 1, 900, 0.3, 130, 'searxng-run'),
  ]
  const tops = new Map<number, Top>([
    [1, top('/', '/sbin/init')],
    [100, top('/srv/my-app', '/usr/bin/node', '/opt/ultimate/bin/ultimate.ts')],
    [200, top('/srv/notes', '/usr/bin/node', '/opt/ultimate/bin/ultimate.ts', '/srv/notes')],
    [300, top(`${home}/my-app-1a2b/worktrees/12`, '/bin/bash', '-c', 'pnpm check')],
    [301, top(`${home}/my-app-1a2b/worktrees/12`, 'node', 'tsc')],
    [400, top(`${home}/my-app-1a2b/worktrees/14`, '/bin/bash', '-c', 'bash slice.sh')],
    [500, top(`${home}/notes-3c4d/worktrees/22`, '/usr/bin/node', 'audit.mjs', '--key=abc123')],
    [501, top(`${home}/notes-3c4d/worktrees/22`, '/usr/lib/chromium/chromium')],
    [600, top(`${home}/my-app-1a2b/worktrees/15`, '/usr/bin/node', 'server/main.ts')],
    [601, top(`${home}/my-app-1a2b/worktrees/15`, '/usr/lib/chromium/chromium')],
    [700, top('/srv/my-app', '/usr/lib/chromium/chromium', '--headless')],
    [800, top('/home/me', 'node', '/home/me/.ultimate/automations/my-app@main/A8/run')],
    [900, top('/', '/venv/bin/python3', '/venv/bin/searxng-run')],
  ])
  const list = owners(procs, tops, context)
  const find = (kind: string, conversation?: number) =>
    list.find((owner) => owner.kind === kind && owner.conversation === conversation)

  test('names each group in the user’s terms, with what it started', () => {
    expect(
      list.map(({ kind, project, conversation, label, cpu, rssMiB, processes }) => ({
        kind,
        project,
        conversation,
        label,
        cpu,
        rssMiB,
        processes,
      })),
    ).toEqual([
      {
        kind: 'work',
        project: 'my-app',
        conversation: 14,
        label: 'slice.sh',
        cpu: 5.5,
        rssMiB: 1820,
        processes: 4,
      },
      {
        kind: 'work',
        project: 'notes',
        conversation: 22,
        label: 'audit',
        cpu: 2,
        rssMiB: 450,
        processes: 2,
      },
      {
        kind: 'job',
        project: undefined,
        conversation: 12,
        label: 'pnpm check',
        cpu: 1.5,
        rssMiB: 500,
        processes: 2,
      },
      {
        kind: 'system',
        project: undefined,
        conversation: undefined,
        label: 'searxng-run',
        cpu: 0.3,
        rssMiB: 130,
        processes: 1,
      },
      {
        kind: 'host',
        project: 'my-app',
        conversation: undefined,
        label: 'Ultimate',
        cpu: 0.2,
        rssMiB: 650,
        processes: 3,
      },
      {
        kind: 'host',
        project: 'notes',
        conversation: undefined,
        label: 'Ultimate',
        cpu: 0.1,
        rssMiB: 490,
        processes: 2,
      },
      {
        kind: 'preview',
        project: 'my-app',
        conversation: 15,
        label: 'preview',
        cpu: 0.05,
        rssMiB: 950,
        processes: 2,
      },
      {
        kind: 'browser',
        project: 'my-app',
        conversation: undefined,
        label: 'chromium',
        cpu: 0,
        rssMiB: 700,
        processes: 2,
      },
      {
        kind: 'automation',
        project: 'my-app',
        conversation: undefined,
        label: 'A8',
        cpu: 0,
        rssMiB: 60,
        processes: 1,
      },
      {
        kind: 'system',
        project: undefined,
        conversation: undefined,
        label: 'systemd',
        cpu: 0,
        rssMiB: 10,
        processes: 1,
      },
    ])
  })

  test('shows no argument values, only program names', () => {
    expect(JSON.stringify(list)).not.toContain('abc123')
    expect(find('job', 12)?.job).toBe('my-app:background:7')
  })
})
