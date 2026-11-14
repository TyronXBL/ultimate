# memory

Keeps a RAM floor: heavy jobs Ultimate starts wait or are refused while they would take available RAM below `memory.minAvailableMiB`.

## Setting

`memory.minAvailableMiB` (in `~/.ultimate/settings.json` only, since RAM is the machine's; off by default) is how much
RAM, in MiB, must stay available (`MemAvailable` in `/proc/meminfo`). It is read at every admission, so a change applies
at once. Linux only: elsewhere nothing is read and nothing is gated.

## What it guarantees

Nothing hard: admission is best effort. The hard limit, where there is one, comes from the operating system, for
example a systemd cgroup cap on the service Ultimate runs in (`MemoryHigh=`, `MemoryMax=`), which holds everything
Ultimate starts. Admission keeps jobs from starting into that cap: it estimates, and RAM that something else takes
later is not counted. It is serialized, though: every starter takes one lock file in `TMPDIR` (previews share it with
their host), and each admitted job reserves its need for a minute, until its own allocations show in `MemAvailable`,
so two starters never both pass on the same free RAM.

## Gates

Each starter estimates its job's need with `lib/memory.ts` and starts it only when available RAM minus that need
stays at or above the floor and, where Ultimate's cgroup or an ancestor has a soft cap (`memory.high`, a systemd
`MemoryHigh=`), what that cgroup and the jobs' slice hold that the kernel cannot drop (`memory.current` less file
cache and reclaimable slab, so cache a finished job left behind keeps nothing out) plus that need stays under it:
the same locked step, the same one-minute reservations, counted against both. Every host on the machine and all they
start share that cap, so RAM can be free while the service is full; on 2026-11-12 at 01:23 UTC two `pnpm check` runs
filled the 5632 MiB cap with 5.1 GB of RAM still available, and the kernel's reclaim (memory pressure 80 %, swap full)
made each check take 20 min instead of under one (#227574). A job waiting for it says so ("waiting for memory: 5.4 of
5.5 GiB of the service's memory cap in use, needs 2200 MiB under it"). The cap rule applies while the floor is set; no
cap adds no rule. Heavy jobs also take turns in the machine's heavy-work queue (`lib/slot.ts`, below):

| Starter                      | Need                                      | Below the floor                                                                                      |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `background` tool            | by its command                            | a heavy one waits at the head of the queue for up to 30 min, then delivers a `not-started` card      |
| lander checks (`workspaces`) | its heaviest check group, by command      | waits at the head of the queue the same way (step "waiting: next in line …"), then fails the landing |
| CI gate's local fallback     | each suite, by command                    | waits at the head of the queue for up to 10 min, then fails the gate                                 |
| `instance start`             | 1536 MiB                                  | refused, listing previews and other process groups with their RSS                                    |
| `bash` tool                  | by its command; only known heavy commands | refused before it runs, naming the exact `background` call to make instead                           |

## Heavy-work queue

A heavy command (any command with a need above, so tests, checks, installs, builds and Ultimate servers) runs with at
most the machine's limit of heavy jobs at once (`heavyWork.maxJobs` in `~/.ultimate/settings.json`, a whole number,
default one, read at every look), whichever Ultimate or preview starts it, in the order the jobs asked. `lib/slot.ts`
keeps the queue in `slot.json` next to the admission's reservations, under the same lock: a job takes a place only
when fewer than the limit hold one, no job that asked earlier waits, and RAM above the floor admits it, all in one
locked step; RAM is admitted per job, so a second job never starts into the floor. "The slot" below means a place.

- **Who queues.** A heavy `background` command waits durably in line, looking every 5 s, and starts by itself; its
  tool answer and the Tasks panel say its place and what it waits for. The lander holds the slot for setup and its
  heavy checks and lets it go before the light ones (the CI gate waits on a remote); the CI gate's local fallback queues
  its suites itself. A heavy `bash` command runs only while the slot is free and nobody waits, holding it while it
  runs; otherwise it is refused. Light commands never queue, and previews count only through RAM: a running preview's
  memory lowers what the next job is admitted against.
- **Who holds.** A running job holds the slot as long as its holder process lives (a background command's leader, or
  the Ultimate or CI gate process doing the work), checked by pid and start time, so a job that dies frees the slot at
  the next look. A stalled agent holds nothing: the slot belongs to jobs, never to a conversation. A hung command holds
  it until its timeout.
- **What survives.** Each waiter keeps the time it asked in its own durable state and says so again at every look, so
  the order survives a host restart (a host down for over 2 min drops its waiters until they look again, which can let
  a later job go first); each holder says so again at every look too. When the file disappears (the daily temp cleanup,
  by hand), nobody gets the slot for 30 s, until every running job has put itself back. Only a process that saw the
  file can tell it was removed: a host started after the removal takes it for a first use and waits for nothing.
- **Private TMPDIRs.** A lander check runs with a TMPDIR of its own; `ULTIMATE_SLOT_TMPDIR` names the machine's, so the
  CI gate's local fallback queues with everyone else.
- **Nested work.** A slot job's processes carry `ULTIMATE_SLOT`; heavy work they start themselves (a scratch server's
  own jobs) is part of that job and never queues behind it.

## CPU admission

`cpu.maxLoadPerCore` (in `~/.ultimate/settings.json` only, a number, off by default; Linux only) makes the queue judge a
job by what it does, not only by what its command is called (`lib/cpu.ts`, #227574: on 2026-11-11 a wrapper script,
`pnpm mutate:changed` and two Playwright audits run from plain bash all counted as light and drove load to 36 on 6
cores). With it set:

- **Load gate.** The job at the head of the line with a free place (a `background` command, the lander's heavy step,
  the CI gate's local fallback) starts, while nothing of the queue runs, only while the one-minute load is below
  `maxLoadPerCore` times the core count (1: no task waits for a CPU) and CPU pressure (`/proc/pressure/cpu`, `some
  avg10`) is below 20 %, which shows a job that fills the machine within seconds where the load average lags a minute.
  Beside running queue jobs (a limit above one), it starts once each of them has run a minute, so the load shows it,
  and while the load is below twice that bound: one job already fills the pressure, and one 8-worker test run alone
  (load 14.6 on 6 cores) keeps a second out. It says so while it waits ("waiting for CPU: load 27.6 on 6 cores, CPU
  pressure 36 %; starts below load 6 and 20 %"). Load from work the queue does not run (nothing of it holds a place)
  delays it at most 5 min; then it starts anyway and says it started under pressure. Load from the queue's own jobs
  is a turn and never forces a start.
- **Every `background` command queues**, in the same line as the heavy ones. One whose text names nothing heavy takes
  a place on probation and is measured: above one core on average over 20 s (or sooner, once it has used that much)
  it keeps the place like a known heavy job; otherwise it gives it back and runs on as light. A heavy one (known from
  its command, or measured) gives its place back below 0.1 core for 5 min, so an idle server or a run that hangs never
  holds one (a test run idle for an hour held the queue on 2026-11-11; a real e2e run idles at 0.25 cores over its
  quietest minute). A job without a place that turns heavy (busy again after giving its place back, or light from its
  probation and above one core for 20 s later) takes a free place, before any waiter, or is ended like a heavy bash
  command beside a full queue (its group stopped, TERM then KILL; the card says why and to run it again): nothing
  measured runs beyond the limit, a dev server compiling while every place is taken included. Pausing it instead
  was tried and dropped: no pause by signals stayed safe against crashes, lost leaders and processes that keep
  starting others. Light jobs started together begin about 20 s apart each per place, and wait while every place is
  taken.
- **Plain `bash`.** A command the list does not know runs at once and is measured every 5 s. Above one core for 30 s
  it takes a place if one is free and nobody waits, and holds it to its end; otherwise it is stopped: TERM to every
  process it started, KILL after 3 s, and the tool result names what held the slot, the CPU it measured, that files
  it wrote may be incomplete, and the `background` call to make. A command the list knows is refused up front.

A job is measured by its session (the CPU time in `/proc` of every process in the session its shell starts), not its
process group, since `timeout` moves its command into a group of its own. What still gets through, seen only by the
load gate: a process that leaves the session (`setsid`, a daemon that detaches), a process left running after its
`bash` call returned (`nohup … &`), work of other users and programs, and work started on a host that runs older code.
Previews (`instance start`) are not gated: they count through the load they cause. Nothing running is stopped because
of load alone.

A command's need comes from what it runs outside quotes: `pnpm check` and `fix` about 2200 MiB (measured: their
`oxlint-tsgolint` peaks at 1.7 GB beside a 450 MB node); test runs (`pnpm test`, `test:e2e`, `vitest`, `playwright`)
and Ultimate servers (`node server/main.ts`) about 1536 MiB; installs and builds about 1024 MiB; anything else 0, so it only waits once the floor is already breached. The match is by name, not by command
position: an unquoted `vitest` in a path or a search pattern counts too, so quote such arguments or use `background`.

The `ci` tool runs nothing on this machine and is not gated; test suites are gated where they start, not per server a
test boots. A background command whose first attempt was interrupted by a host crash is stopped and started again: a
light one at once, without admission, since it already ran; a heavy one through the queue, keeping its place when it
had waited before and joining the end of the line when it had started at its first look.

## Status line

While available RAM is within 1 GiB of the floor, an amber chip shows it. Its popover lists the largest process groups
this Ultimate started (previews, scratch servers, background commands, test runs), by RSS, with the conversation whose
worktree they run in, and, when Ultimate's cgroup limits memory, its `memory.current` beside `memory.high` and
`memory.max`. The chip polls `memory/state` every 15 s.
