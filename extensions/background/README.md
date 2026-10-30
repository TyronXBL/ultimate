# Background

Run a local shell command asynchronously; the caller receives a result card when it finishes.

The `background` tool accepts `command` and an optional timeout in seconds (default 3600). Commands run with `nice -n 10` in their own process group, from the calling conversation's workspace when available. The durable task polls for completion, timeout, or a lost process group (for example after reboot). Stopping the owning conversation stops the process and delivers no result.

Logs and process status files live in `<host home>/background/`. The result includes the command, working directory, exit code or outcome, elapsed seconds, an output tail capped at about 4 KB, and the log path. Logs are left for the agent to read; these are small files in the host home and there is no cleanup policy beyond that.
