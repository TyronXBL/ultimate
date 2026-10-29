# Ideas

The project's idea board: the user collects ideas, launches one into a branch through @ultimate and follows it to landed.

## State

The `ideas` document on conversation 1 (conversation scope, latest history, initial on fork) holds
`{ next, items: Idea[] }`, oldest first (`refs.ts`): `{ id, title, notes?, tags, by: 'user' | 'ultimate', from?, at,
parked?, launch?: { size: 'assess' | 'build', at, branch? } }`. A title is one trimmed line of at most 120 characters,
notes at most 4000, tags at most 8 short lowercase words (a leading `#` is dropped), `from` a `#<conversation>/<entry>`
breadcrumb. Everything else about an idea's progress (assessing, waiting on the user, landing, landed) is read live
from its branch, never copied here.

## Actions

All user-only, for the board.

- `add { title, notes?, tags? }` → the new idea, by the user.
- `update { id, title?, notes?, tags? }` → the idea; empty notes remove them.
- `park { id, parked }` → the idea, parked or back on the board.
- `remove { id }` → `{ id }`; a launched idea is parked instead.
- `launch { id, size }` → the idea, launched. It refuses a parked idea and one already linked to a branch.

## Launch

Launching sets `launch { size, at }` and places an `ideas.launch` input `{ id, title, size }` in @ultimate's
conversation, after its current run when it is busy, keyed by request id `ideas.launch:<id>:<at>`. Launching again
before a branch is linked keeps the first launch, so it never places a second input. The input asks @ultimate to start
the idea's branch (assess first, or build when the user chose so) with its title, tags and notes, then link it.
Only @ultimate launches branches, so a branch's answers and decisions come back to it, and it relays them to the user
as usual.

## Agents

`idea {action: 'add', title, notes?, tags?, from?} | {action: 'link', id, branch} | {action: 'list'}` belongs to
@ultimate: it is deferred and named in `agents/ultimate.md`, and any other caller is refused. `add` keeps an idea a
branch, dream or survey proposed for later; `link` records the branch it started for a launched idea; `list` gives one
line per idea, `- <id> [idea | launching | parked | #<branch>] <title> (<tags>)`. A coordinator that wants an idea on
the board asks @ultimate.
