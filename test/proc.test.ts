// The /proc parsers RAM admission, the heavy-work queue's CPU measurement and the Machine dashboard read through.
import { expect, it } from 'vitest'
import {
  avg10,
  bootTime,
  cgroupPath,
  kernelThread,
  parseMeminfo,
  parseStat,
  parseStatus,
} from '../lib/proc.ts'

const rest =
  '18446744073709551615 94372801241088 94372801267633 140721769564128 0 0 0 0 0 0 0 0 0 17 5 0 0 0 0 0 0\n'
it.each([
  [
    'a name with spaces and a parenthesis in it',
    `4242 (node (vitest) x) S 4200 4210 4100 34816 4210 4194304 5000 0 12 0 1500 250 30 20 20 0 9 0 158759547 1213337600 51200 ${rest}`,
    {
      pid: 4242,
      comm: 'node (vitest) x',
      ppid: 4200,
      pgrp: 4210,
      session: 4100,
      ticks: 1750,
      childTicks: 50,
      start: 158759547,
      rssPages: 51200,
    },
    false,
  ],
  [
    'kthreadd',
    `2 (kthreadd) S 0 0 0 0 -1 2129984 0 0 0 0 0 1060 0 0 20 0 1 0 16 0 0 ${rest}`,
    {
      pid: 2,
      comm: 'kthreadd',
      ppid: 0,
      pgrp: 0,
      session: 0,
      ticks: 1060,
      childTicks: 0,
      start: 16,
      rssPages: 0,
    },
    true,
  ],
  [
    'a kernel worker',
    `1003417 (kworker/0:0H-kblockd) I 2 0 0 0 -1 69238880 0 0 0 0 0 461 0 0 0 -20 1 0 156269697 0 0 ${rest}`,
    {
      pid: 1003417,
      comm: 'kworker/0:0H-kblockd',
      ppid: 2,
      pgrp: 0,
      session: 0,
      ticks: 461,
      childTicks: 0,
      start: 156269697,
      rssPages: 0,
    },
    true,
  ],
])('parses a /proc/<pid>/stat line: %s', (_name, line, stat, kernel) => {
  expect(parseStat(line)).toEqual(stat)
  expect(kernelThread(parseStat(line))).toBe(kernel)
})

it.each([
  [
    'a process in a nested PID namespace',
    'Name:\tnode\nPid:\t4242\nPPid:\t4200\nNSpgid:\t4210\t1\nVmPeak:\t 1300000 kB\nVmRSS:\t  204800 kB\n',
    { ppid: 4200, pgid: 4210, rssKiB: 204800 },
  ],
  [
    'a kernel thread: no VmRSS',
    'Name:\tkworker/0:0H\nPPid:\t2\nNSpgid:\t0\n',
    { ppid: 2, pgid: 0, rssKiB: 0 },
  ],
])('parses a /proc/<pid>/status: %s', (_name, text, status) => {
  expect(parseStatus(text)).toEqual(status)
})

it.each([
  [
    'some and full',
    'some avg10=27.82 avg60=26.32 avg300=17.26 total=72450531072\nfull avg10=3.50 avg60=0.00 avg300=0.00 total=0\n',
    27.82,
    3.5,
  ],
  ['some only (an older kernel)', 'some avg10=6.00 avg60=4.10 avg300=2.00 total=1000\n', 6, 0],
  ['no pressure file', '', 0, 0],
])('reads avg10 of a pressure file: %s', (_name, text, some, full) => {
  expect([avg10(text, 'some'), avg10(text, 'full')]).toEqual([some, full])
})

it.each([
  [
    'cgroup v2',
    '0::/user.slice/user-1001.slice/user@1001.service/app.slice/ultimate.service\n',
    '/user.slice/user-1001.slice/user@1001.service/app.slice/ultimate.service',
  ],
  [
    'hybrid: v1 hierarchies before the v2 line',
    '12:memory:/user.slice\n3:cpu,cpuacct:/user.slice\n1:name=systemd:/user.slice/user-1001.slice/session-3.scope\n0::/user.slice/user-1001.slice/session-3.scope\n',
    '/user.slice/user-1001.slice/session-3.scope',
  ],
  ['cgroup v1 only', '12:memory:/user.slice\n1:name=systemd:/init.scope\n', undefined],
  ['no cgroup file', '', undefined],
])('reads the cgroup path: %s', (_name, text, path) => {
  expect(cgroupPath(text)).toBe(path)
})

it('parses the kB fields of /proc/meminfo', () => {
  const meminfo = parseMeminfo(
    'MemTotal:       12238816 kB\nMemFree:         2433948 kB\nMemAvailable:    8881272 kB\nActive(anon):    1931472 kB\nSwapTotal:        524284 kB\nSwapFree:         352840 kB\nHugePages_Total:       0\n',
  )
  expect(meminfo).toEqual({
    MemTotal: 12238816,
    MemFree: 2433948,
    MemAvailable: 8881272,
    'Active(anon)': 1931472,
    SwapTotal: 524284,
    SwapFree: 352840,
  })
  expect(parseMeminfo('').MemAvailable).toBeUndefined()
})

it('reads the boot time from /proc/stat', () => {
  expect(
    bootTime('cpu  28718138 28582302 32696129 834139081\nintr 0\nbtime 1793049170\nprocesses 1\n'),
  ).toBe(1793049170)
})
