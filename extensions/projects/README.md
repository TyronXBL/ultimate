One list of every Ultimate project on this machine, and the way to start a stopped or new one from the title bar.

## Actions

`list { null }` → `{ projects: LocalProject[]; remotes: RemoteProject[] }` (contract in `refs.ts`). `projects` comes
from `host.projects()`: every home in `~/.ultimate/projects/` plus this one, with `root` when its `project.json` is
there, `current` for this server, `url` (`http://127.0.0.1:<port>`) while its supervisor runs, `activeAt` the latest
write to one of its top-level conversations, and `tailnet` while it runs and publishes itself there: this server's
own address for the current project, else `https://<dns>:<port>` from the port its project registered in
`~/.ultimate/tailscale.json`, while the server whose pid starts that entry's owner token runs (the registry keeps a
project's port after it stops). The current project comes first, then the rest by name. `remotes` is the `remotes` user
setting (`lib/remote.ts`), `{ machine, name, url }[]`.

`start { root, create? }` → `LocalProject | { missing }`. `root` is an absolute folder, or `~/` for the user's home.
When nothing is there it resolves `{ missing }` with the absolute path; `create: true` makes that folder first
(`mkdir -p`, no `git init`: the new project's onboarding offers git), refusing a path inside this Ultimate's checkout,
its project or `~/.ultimate` (every project's home and worktrees). An existing non-folder is refused. It resolves at once for
a project that already runs, and otherwise starts Ultimate there and resolves once `list` reports it running,
polling every 500 ms for up to 60 seconds. With the host's tailscale ready it waits up to 15 seconds more for the
project's tailnet address, then resolves without one.
A start that fails reports the tail of the child's log, kept in a file in the system temporary directory. Two starts
of one folder share the first: the in-flight ones live in `host.resource('projects.starts')`.

## Starting a project

Start runs `bin/ultimate.ts <root> --no-open`, the same supervisor a terminal start runs, detached, with `cwd` the
folder and none of this server's `ULTIMATE_*` variables, so the child never adopts the host's home, port or
generation. Only folders are started, and never this server's own project. A folder opened for the first time gets
its home under `~/.ultimate/projects/` like any other, and its `.ultimate/` extensions, agents and settings stay off
until the user chooses that project's setup. Starting an existing project is resuming it: its unfinished work,
automations and conversations are as it left them. The child stays in this server's cgroup, under the systemd unit
here, so stopping the service stops every project it started; start them from a terminal to keep them independent.

## UI

The title bar's project chip becomes one menu:

- **Projects** lists this machine's projects with this one highlighted. A running one opens in this window: at its
  port on this page's host when the page is on loopback, or at its tailnet address on a page opened from elsewhere.
  One reachable neither way is disabled with the reason. A stopped one shows **Start**, which starts it and then opens
  it; a quiet line says that starting resumes its unfinished work and automations.
- **New or open folder…** (also in ⌘K) takes a path and starts Ultimate there, then opens it. A path with nothing
  there asks "Create <path> and start a new project there?", and **Create** makes the folder and starts it.
- **Previews** lists the `instance` previews of this host, on loopback pages only, and shows one in the frame as before.
- **Other machines** opens the `remotes` in a new tab.
