Shows the machine: the heavy-work queue (what runs, what waits and why), CPU load, memory against the RAM floor, swap and the temp folders over the last hour, and who uses the machine now, grouped by project and conversation. Read-only.

## Where

The **Machine** tab of the System surface (⌘K "Open Machine"), and a status-line chip that shows the queue's length,
turns amber when something needs attention (RAM within 1 GiB of the floor, the host's cgroup at its memory cap, tasks
stalled on memory or IO 20 % of the time, load at 1.5 times the cores or more, a temp folder 90 % full, work outside
the queue using more than a core) and opens the tab. A nearly full swap alone is no
alarm: a small swap stays full for days on a healthy machine.

## What it reads

- **The queue** through `lib/slot.ts`'s own derivation: `peekSlot` for a claim at the very end of the line lists every
  job that holds the slot and every waiter in order (`queue.ts`). A waiter waits behind the job just ahead of it; the
  first one, with nothing running, waits for RAM (`checkRam`, the admission's own computation with its reservations),
  for load (the one-minute load at or above the cores) or starts at its next look. With #227574's queue a job measured
  on probation shows as `measuring`. Every Ultimate and preview on the machine shares the queue, so other projects'
  jobs show too, named by project; this project's link to their conversations.
- **Who uses the machine** from `/proc/<pid>/stat` (CPU, RSS, parent, process group) and, once per process, the command
  line and folder of each group's topmost process (`owners.ts`). A group is named by what it is and by the group that
  started it: a project's host (its supervisor's group, from the projects' `ultimate.lock`), a queue job (the group its
  holder leads, and what it starts), a preview (`server/main.ts`), a Chromium, an automation, a landing's checks, a
  conversation's work outside the queue (by its worktree), or a system program. Only program names are shown, never
  argument values; other users' processes show by program name.
- **Resources**: `/proc/loadavg`, `/proc/meminfo`, `statfs` of `$TMPDIR` and `/tmp` (a RAM file system is marked),
  the stall shares in `/proc/pressure/{cpu,io,memory}`, and the memory controller of the cgroup this host runs in
  (`memory.current` against `memory.high` and `memory.max`, and its `memory.pressure`). Under systemd that cgroup holds
  every project's host and everything they start: at its soft cap the kernel reclaims and re-reads pages of all of
  them, so the machine crawls while `MemAvailable`, and the RAM floor, still show gigabytes free. The chip and the
  header call it out from 256 MiB below the cap or 20 % memory stall.

## Cost and history

One look reads about one small file per process plus the queue under its lock: about 15 ms of CPU on the main thread
with 300 processes. It runs every 15 s in the background and every 3 s while a dashboard asks (`state`, polled every
3 s while the tab is on screen, keeps it fast for 20 s). The chip's `summary` reads the latest look and samples
nothing.

History is an hour of samples in this process's memory: every sample of the last 10 minutes, one per 15 s before. It
survives a reload of this extension and starts empty after a host restart; nothing is written to disk.

## Actions

- `state { since? }` → `MachineState` (`refs.ts`): the queue, owners, temp folders, pressure and the samples after
  `since`.
- `summary` → `{ running, waiting, pressure }`.

Controls (run next, cancel) would go on the queue's rows; there are none yet.
