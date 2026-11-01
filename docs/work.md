# How work is organised: a forest of conversation trees

A project is a forest of conversation trees, like commit histories. [AGENTS.md](../AGENTS.md) carries the short
version every agent starts with; this is the whole picture, for explaining Ultimate to a user.

- **Roots** run no turns. Each keeps a project memory (decisions, facts, lessons by slug); a branch starts from the
  root's memory index and recent landings. The root's read-only tally stays the browsable project context: branch
  intents, latest conversation abstracts and landings with divergence and `#conversation/entry` breadcrumbs. The UI
  calls a tally **context** and shows it as the read-only **History** page (the sidebar's project path opens it), with
  **Open in Zed** and **Back to @ultimate**; the sidebar's Memory row shows the memory's estimated tokens (what a
  branch starts from) and opens the Memory surface, and each root heads its tree with its last three events
  (landings, notes, branches, compactions). Start a project with @ultimate: Continue on Get ready, or **Set up with
  @ultimate** on the Start here card that @ultimate's conversation shows until onboarding has run. It walks the user
  through Ultimate, handles setup cards, reads the project and writes its first memories with `remember`; the user's
  answer about the project becomes instructions, kept verbatim as a memory. The tally then builds up from branches
  and landings. @ultimate maintains memory with `remember` and the memory review (`extensions/lineage/README.md`);
  the user can compact a tally with ⌘K Compact while it is shown. A project has one root: independent work goes into
  branches. Roots and standing agents are never concluded or cleared, only compacted.
- **A branch** is a feature, a fix, an experiment. @ultimate picks a root by reading its tally, then starts a
  coordinator branch that starts from its memory brief (or, without memories, its tally) before its prompt. A branch
  is never a subagent.
- **Talk to @ultimate in its conversation.** The user's standing agent starts and steers branches there. The first
  sidebar row (on phones, the top-bar **@ultimate** button) opens it; its messages and questions to you appear in
  that transcript. Conversations and roots are not created by hand.
- **Branches ask you in their own conversation.** A coordinator sends its decisions to @ultimate, which weighs in
  (its picks, or deciding itself on a hands-off goal); the branch then asks you with a card there. @ultimate's
  conversation shows a pointer to it, and your answer reaches @ultimate as a note.
- **Coordinators carry the work.** A branch is the conversation; the coordinator is the agent that runs it, so the UI
  labels it `branch · coordinator`. A branch plans, decides and verifies; subagents are for bounded execution and
  reconnaissance, and the lander is the final gate on main.
- **Zoom out when you need to.** Read any root or sibling with codemode `ultimate.entries(id)` and
  `ultimate.search()`; commits name the conversation that made them (`Ultimate-Conversation` trailer).
- **Talk across the tree without waking anyone.** `note` leaves context in another conversation for its next turn;
  `notify` tells you when another conversation finishes. Resuming a branch brings a catch-up of its tree's tally
  (older updates collapse when needed), then new target commits, overlaps first.
- **State divergence.** Reports and `workspace submit` say how the result differs from the task as given: new
  agreements, a different approach or changed scope. Say "None" when it matches.
- **Conclude** a conversation when its work is done; it stays readable and can be resumed. A branch whose submission
  lands is concluded by the landing, unless work is still under way (a subagent, a reply it waits for, queued input),
  and whoever started it wakes with the landing card. A failed submission wakes the branch to fix it and submit again.
- **UI polish lands when the user says so.** For small look-and-feel work (an animation, a loading state, spacing,
  a card), run preview rounds (the `ui-preview-round` skill) and do not `workspace submit` until the user has clicked
  around and approved it. Larger UI features and anything with behaviour behind it land as usual.
- **Hands-off goals.** ⌘K Go hands-off… puts @ultimate on a goal while the user is away: it gives the go, decisions
  and preview approvals in their place and records each with its reason (`extensions/goal/README.md`).

`extensions/lineage/README.md` has the mechanics.
