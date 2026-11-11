# background

Runs a local shell command in the background and wakes the caller once with a result card.

The `background` tool takes `command` and an optional `timeout` in seconds (default 3600) and returns at once. A
durable `background.run` task then:

1. starts the command with `bash -c`, niced (`nice -n 10`), in the directory the conversation's bash runs in, as the
   leader of its own process group; stdout and stderr go to a log file;
2. when the command ends, its leader records the exit code and stays alive, so the pid file still proves the group is
   this task's; should no host come within an hour, the leader stops its group itself, itself last;
3. looks for that code every 3 s at first, then up to every 15 s; once it is there, or at the timeout (`timeout`), it
   stops the whole group (TERM, then KILL) before it reports, so nothing the command started outlives the result. A
   group gone without a code is `lost` (killed from outside, or a reboot). When the leader was killed from outside, the group
   can no longer be proven this task's: nothing is signalled, and the card says what to check;
4. submits one `background.result` input (request id `background.result:<task>`): outcome, exit code, duration, the
   last 40 lines of output (at most 4 KB) and the log path. While the caller or a conversation above it is concluded
   (a landing concludes a branch without stopping its commands), the same card goes in as a note that starts no run;
   the conversations service's `resultIn` decides it in the commit that submits.

A heavy command (tests, checks, installs, builds, a server: `commandNeedMiB` in `lib/memory.ts`) waits before step 1
in the machine's heavy-work queue (`lib/slot.ts`, `extensions/memory/README.md`): one heavy command at a time across
every Ultimate on the machine, in the order they asked. The task sleeps durably, looks again every 5 s and starts the
command by itself once its turn comes and RAM above the floor (`memory.minAvailableMiB`) admits it; RAM short at the
head of the line gives up after 30 min with a `not-started` card listing what uses RAM. The tool's answer says its
place and what it waits for ("Queued, 2nd in line for the heavy-work slot, behind `pnpm check` from #12 in my-app
(running 2 min); …"); while it waits the Tasks panel shows the same, and the result card how long it was queued. It
holds the slot while its group runs and lets it go once the group is stopped, when it is concluded, or when it gives
up. A light command starts at once, or waits for RAM the same way when the floor is already breached.

The shell, not the host, writes the log and the code, so a command keeps running through a host restart and its
result still arrives. The command keeps running across the caller's turns and its Stop button; concluding the
conversation aborts the task, which stops the command's group and wakes nobody.

Logs, exit codes and pid files live in `<home>/background/<task>.*`. Logs stay for the agent to read and are not
cleaned up.

Known limitations, all of them needing a host outage or a leader killed from outside:

- When the leader was killed from outside, the pid file is removed even though the group could not be verified, and
  the card's note blames that leader even if the group id was reused meanwhile. Nothing is signalled either way; the
  note only points at a read-only `ps` check.
- The leader's own drain after an hour without a host was proven once by hand, not by a committed test.
- Stop does not stop a running command, like every background task; concluding the conversation does.
