# background

Runs a local shell command in the background and wakes the caller once with a result card.

The `background` tool takes `command` and an optional `timeout` in seconds (default 3600) and returns at once. A
durable `background.run` task then:

1. starts the command with `bash -c`, niced (`nice -n 10`), in the directory the conversation's bash runs in, as the
   leader of its own process group; stdout and stderr go to a log file;
2. when the command ends, its leader records the exit code and stays alive, so the pid file still proves the group is
   this task's (an hour at most, should the host never come back);
3. looks for that code every 3 s at first, then up to every 15 s; once it is there, or at the timeout (`timeout`), it
   stops the whole group (TERM, then KILL) before it reports, so nothing the command started outlives the result. A
   group gone without a code is `lost` (killed from outside, or a reboot). Processes it could not stop (their leader
   killed from outside) are named on the card with the command that stops them;
4. submits one `background.result` input (request id `background.result:<task>`): outcome, exit code, duration, the
   last 40 lines of output (at most 4 KB) and the log path.

The shell, not the host, writes the log and the code, so a command keeps running through a host restart and its
result still arrives. The command keeps running across the caller's turns and its Stop button; concluding the
conversation aborts the task, which stops the command's group and wakes nobody.

Logs, exit codes and pid files live in `<home>/background/<task>.*`. Logs stay for the agent to read and are not
cleaned up.
