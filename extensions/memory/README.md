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
stays at or above the floor. Heavy jobs also take turns in the machine's heavy-work queue (`lib/slot.ts`, below):

| Starter                      | Need                                      | Below the floor                                                                                      |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `background` tool            | by its command                            | a heavy one waits at the head of the queue for up to 30 min, then delivers a `not-started` card      |
| lander checks (`workspaces`) | its heaviest check group, by command      | waits at the head of the queue the same way (step "waiting: next in line …"), then fails the landing |
| CI gate's local fallback     | each suite, by command                    | waits at the head of the queue for up to 10 min, then fails the gate                                 |
| `instance start`             | 1536 MiB                                  | refused, listing previews and other process groups with their RSS                                    |
| `bash` tool                  | by its command; only known heavy commands | refused before it runs, naming the exact `background` call to make instead                           |

## Heavy-work queue

A heavy command (any command with a need above, so tests, checks, installs, builds and Ultimate servers) runs one at a
time on the whole machine, whichever Ultimate or preview starts it, in the order the jobs asked. `lib/slot.ts` keeps
the queue in `slot.json` next to the admission's reservations, under the same lock: a job takes the slot only when
nothing else holds it, no job that asked earlier waits, and RAM above the floor admits it, all in one locked step.

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

A command's need comes from what it runs outside quotes: test runs (`pnpm test`, `test:e2e`, `vitest`, `playwright`)
and Ultimate servers (`node server/main.ts`) about 1536 MiB; `pnpm check`, `fix`, `install` and builds about
1024 MiB; anything else 0, so it only waits once the floor is already breached. The match is by name, not by command
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
