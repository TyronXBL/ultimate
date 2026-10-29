# Ideas

The project's idea board: the user collects ideas, launches one into a branch through @ultimate and follows it to landed.

## State

The `ideas` document on conversation 1 (conversation scope, latest history, initial on fork) holds
`{ next, items: Idea[] }`, oldest first (`refs.ts`): `{ id, title, notes?, tags, by: 'user' | 'ultimate', from?, at,
parked?, launch?: { size: 'assess' | 'build', at, branch? } }`. A title is one trimmed line of at most 120 characters,
notes at most 4000, tags at most 8 short lowercase words (a leading `#` is dropped), `from` a `#<conversation>/<entry>`
breadcrumb. `images` is the id of a display-only `ideas.images` entry `{ idea, images }` on conversation 1 holding up to
4 pictures (PNG, JPEG, WebP or GIF, at most 2 MiB each, the composer's limits), so the document stays small and the tally
never reads them; setting new pictures writes a new entry. Everything else about an idea's progress (assessing, waiting on the user, landing, landed) is read live
from its branch, never copied here.

## Actions

All user-only, for the board.

- `add { title, notes?, tags?, images? }` → the new idea, by the user.
- `update { id, title?, notes?, tags?, images? }` → the idea; empty notes remove them, `images` replaces them all and
  `[]` removes them.
- `park { id, parked }` → the idea, parked or back on the board.
- `remove { id }` → `{ id }`; a launched idea is parked instead.
- `launch { id, size }` → the idea, launched. It refuses a parked idea and one already linked to a branch.

## Launch

Launching sets `launch { size, at }` and places an `ideas.launch` input `{ id, title, size }` in @ultimate's
conversation, after its current run when it is busy, keyed by request id `ideas.launch:<id>:<at>`. Launching again
before a branch is linked keeps the first launch, so it never places a second input. The input asks @ultimate to start
the idea's branch (assess first, or build when the user chose so) with its title, tags and notes, then link it. It
carries the idea's pictures, and then asks @ultimate to pass them on with `branch {images: 'latest'}`.
Only @ultimate launches branches, so a branch's answers and decisions come back to it, and it relays them to the user
as usual.

## Board

The **Board** surface (title bar, ⌘K "Switch to Board") shows the ideas by stage: **Ideas → Assessing → Building →
Landed**, with **Parked** folded under Ideas. The add field heads the Ideas column (a title; notes, pictures and tags open
under it); a card's ⋯ edits, parks or brings back an idea, and removes one never launched. **Launch** asks how it starts:
assess first (the default) or build. Everything after that is read live (`data.tsx`, `stage.ts`):

- An assess-first launch stays in Assessing until its branch has a plan epic or commits not yet landed; a build
  launch starts in Building, and so does any branch in the lander's queue. Until @ultimate links the branch the card
  says `launching`.
- A branch says where it stands as its sidebar row does (`sidebar/ui.tsx` `useBranchState`), with a link that opens it.
- A landed branch moves to Landed with its sha, which opens Review of what it brought; one concluded without landing
  moves to Parked as `not built`.
- An idea whose branch has decisions waiting (messages to the user `about` the branch) says `needs you` in the
  waiting tone, sorts first and carries their real answer cards, answered in place exactly as in the chat. Board
  cards take clicks only; the desktop answer keys stay with the shown conversation's newest card.

On a desktop @ultimate's conversation is docked beside the columns, whatever conversation the Agent surface shows.
On a phone the Board is one list with stage pills, what needs you first, filtered by the pills at its top; @ultimate
stays one tap away in the title bar. A launch shows in @ultimate's transcript as an `Idea launched` card on the user's
side, naming the idea, its size and the pictures that went with it.

Pictures (`pictures.tsx`): the form's picture button opens the photo library or the camera on a phone; a paste or a
drop adds them too, up to four. One that does not fit the limits (a phone's photo of several MiB, a HEIC) is redrawn
as a JPEG of at most 2048 px, smaller until it fits. A card shows small thumbnails that open large, loaded once per page
from the idea's `ideas.images` entry and only for an idea that has pictures; editing sends `images` only when they
changed. The entry itself renders as nothing in conversation 1's transcript, the History page.

## Agents

`idea {action: 'add', title, notes?, tags?, from?} | {action: 'link', id, branch} | {action: 'list'}` belongs to
@ultimate: it is deferred and named in `agents/ultimate.md`, and any other caller is refused. `add` keeps an idea a
branch, dream or survey proposed for later; `link` records the branch it started for a launched idea; `list` gives one
line per idea, `- <id> [idea | launching | parked | #<branch>] <title> (<tags>)`. A coordinator that wants an idea on
the board asks @ultimate.
