---
name: ui-preview-round
description: Run a preview round for UI work that lands only with the user's approval (polish, a new card, a panel, anything the task says to preview first). Use when a branch must show the user a running preview, collect approval, and only then workspace submit.
---

# A preview round

UI polish lands only when the user approved it on a running preview. Checks, a review or your own screenshots are not
approval, and one approval covers one round. On a hands-off goal @ultimate approves in the user's place, from your
screenshots: send them with the request.

Steps 2 and 3 preview Ultimate itself (in another project, its `.ultimate/` extensions). For another project's own
app, start the preview its own instructions describe, then go on at step 4.

1. **Commit the round** in your branch. A preview runs your checkout as it is on disk; committing keeps each round
   recoverable.
2. **Start the preview**: `instance start` (or `instance start {subagent: <id>}` for a designer's worktree). It is a
   clean Ultimate with an empty database and a private copy of your user config (`docs/running.md`); open pages switch
   to a rebuilt UI about 2 s after a `web/` or `extensions/` file changes. A change in `server/` or `shared/` needs `instance stop` and a new `start`.
   When the user wants to try a flow themselves, leave them an untouched instance and the exact first prompt to paste.
3. **Seed it like a user**: open @ultimate (the first row of the sidebar) and send real prompts until the state the user should
   judge exists: a long transcript, a running tool, a skill run, an error. Never fake state by writing entries; drive
   it as `verify-ui` describes (`send`, then `until`).
4. **Look first yourself**: follow the `verify-ui` skill. Fix what is off before you ask anyone.
5. **Ask for approval** the way your instructions ask decisions, with the screenshots as `images`. Include the URL (the tailnet URL when the preview chip
   shows one), what changed, a short numbered "what to try" naming the conversation you seeded, and a choice question
   (approve as is, or change something).
   - Just before, check that the preview answers at that URL (a `screenshot` of it).
   - A tool round of only `message` calls to the user ends your run, unless an agent still waits for your answer or a branch whose reply or report you
     read in this run does. So
     the card carries the screenshots itself; any message sent before it goes from codemode or beside another tool
     call, and the message carrying `questions` goes alone and last.
   - A refused card leaves the run going: fix what the tool names and send it again. While the card is open, your next
     input opens with a line listing your open questions; when it is missing there, send it again.
6. **Iterate**: each change is a new commit and a new round; keep the same preview running.
7. **On approval**: remove anything only the preview needed, stop the preview (`instance stop`), then `workspace submit` with the
   divergence. Report the landing in your final answer.
