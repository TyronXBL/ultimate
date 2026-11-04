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
stays at or above the floor:

| Starter                      | Need                                      | Below the floor                                                                        |
| ---------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `background` tool            | by its command                            | waits durably, looking every 10 s for up to 30 min, then delivers a `not-started` card |
| lander checks (`workspaces`) | its heaviest check group, by command      | waits durably the same way (step "waiting for RAM: …"), then fails the submission      |
| `instance start`             | 1536 MiB                                  | refused, listing previews and other process groups with their RSS                      |
| `bash` tool                  | by its command; only known heavy commands | refused before it runs, pointing at `background`                                       |

A command's need comes from what it runs outside quotes: test runs (`pnpm test`, `test:e2e`, `vitest`, `playwright`)
and Ultimate servers (`node server/main.ts`) about 1536 MiB; `pnpm check`, `fix`, `install` and builds about
1024 MiB; anything else 0, so it only waits once the floor is already breached. The match is by name, not by command
position: an unquoted `vitest` in a path or a search pattern counts too, so quote such arguments or use `background`. The `ci` tool runs nothing on this
machine and is not gated; test suites are gated where they start, not per server a test boots.

## Status line

While available RAM is within 1 GiB of the floor, an amber chip shows it. Its popover lists the largest process groups
this Ultimate started (previews, scratch servers, background commands, test runs), by RSS, with the conversation whose
worktree they run in, and, when Ultimate's cgroup limits memory, its `memory.current` beside `memory.high` and
`memory.max`. The chip polls `memory/state` every 15 s.
