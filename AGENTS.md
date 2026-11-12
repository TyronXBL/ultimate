# Ultimate

Ultimate is a local coding agent with a web UI, built on Pi Durable (`@earendil-works/pi-durable`). It runs this
repository while it edits it: you are probably reading this as Ultimate, about to change yourself. Everything below
tells you which change reloads how, so the conversation you are in keeps running.

## How work is organised

A project is a forest of conversation trees, like commit histories. [docs/work.md](docs/work.md) has the whole
picture, the UI included, for explaining Ultimate to a user; `extensions/lineage/README.md` has the mechanics.

- **Roots** run no turns. Each keeps the project memory and a read-only tally of branches, abstracts and landings
  (the History page). A project has one root; independent work goes into branches. Roots and standing agents are
  never concluded or cleared, only compacted.
- **A branch** is a feature, a fix, an experiment. @ultimate starts it from the root's memory brief, run by a
  coordinator that plans, decides and verifies; subagents do bounded execution and reconnaissance, and the lander is
  the final gate on main. A branch is never a subagent.
- **Decisions** go from a coordinator to @ultimate, which weighs in; the branch then asks the user with a card in its
  own conversation.
- **Zoom out** with codemode `ultimate.entries(id)` and `ultimate.search()`; commits name the conversation that made
  them (`Ultimate-Conversation` trailer). `note` leaves context in another conversation without waking it; `notify`
  tells you when one finishes.
- **State divergence.** Reports and `workspace submit` say how the result differs from the task as given: new
  agreements, a different approach or changed scope. Say "None" when it matches.
- **Conclude** a conversation when its work is done; it stays readable and can be resumed. A landing concludes its branch unless work is still under way;
  a failed submission wakes the branch to fix it and submit again.
- **UI polish lands when the user says so.** For small look-and-feel work (an animation, a loading state, spacing,
  a card), run preview rounds (the `ui-preview-round` skill) and do not `workspace submit` until the user has clicked
  around and approved it. Larger UI features and anything with behaviour behind it land as usual.
- **Hands-off goals.** ⌘K Go hands-off… puts @ultimate on a goal while the user is away: it gives the go, decisions
  and preview approvals in their place (`extensions/goal/README.md`).

## Layers and how they reload

- `extensions/<name>/web.tsx`: UI of an extension (slots, panels, surfaces, tool and entry renderers, commands). Rebuilt
  into the page about 2 s after a save; open pages switch to the new bundle (drafts and view kept). A broken facet
  shows an error card; the rest keeps running.
- `extensions/<name>/server.ts`: agent behaviour (system prompt, tools, hooks; Pi Durable extensions). Reinstalled on
  save: running tool calls finish on the old code, the next call uses the new code.
- `extensions/<name>/api.ts`: its contract for other extensions; `export const tier = 'core'` puts it in the
  always-on core tier, which depends only on the core tier, one way
  ([the core tier docs](docs/extensions/core-tier.md)). Goes live with the facets that import it.
- `lib/`: pure helpers extensions share (exec, git, JSON and settings files, secret reads); no state beyond
  `file-memo.ts` caches no caller can tell from a fresh read, no extension
  imports. Goes live like the extensions that import it: rebuilt or reinstalled on save.
- `web/`: the web core (surface host with primitives, SDK in `web/src/sdk`, transcript, composer, palette). Rebuilt
  and switched to like a `web.tsx`.
- `agents/`: subagent definitions (Markdown with frontmatter), read at each use.
- `server/`, `shared/`: core plumbing (harness, storage, API, Vite hookup). Call the `restart` tool: a new process
  boots and type-checks next to the old one; if it fails you get the error and the old process keeps running, if it
  succeeds the run resumes in the new process.
- `bin/`: the supervisor. Only a human restart (`pnpm start`) applies it; keep it tiny and change it rarely.

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart. The browser runs a
production bundle (`server/web.ts`): a change to `web/` or a `web.tsx` rebuilds it in a short-lived child process, and
every open page reloads onto the new bundle, resuming the view and drafts it left; with no page open the next page load
builds it.
A surface is a full-screen app the user switches to (header, ⌘K, `mod+1…9`); the conversation itself is the built-in
`agent` surface, and a project's apps go in `<project>/.ultimate/extensions/` (see [surfaces](docs/extensions/surfaces.md)).
New UI is a new extension folder, not a change to `web/`: follow the `write-extension` skill, which points into
[extensions/README.md](extensions/README.md), and copy the closest existing one (`status-line`, `coding-tools`).

## Developer reference — read when needed

- [Running the server](docs/running.md): before starting, debugging or testing a server or core swap.
- [Worktrees and integration](docs/worktrees.md): before previewing an isolate, landing or recovering a rejected push.
- [Discovery and settings](docs/settings.md): before changing configuration, trust, resources or `summaryModel` (titles, summaries, reply summaries and tree abstracts).
- [Durability](docs/durability.md): before changing persistence, replay or durable UI state.
- [Extension topics](extensions/README.md#topics): before wiring facets, contracts, documents, events or runtime inspection.
- [Subagents](docs/subagents.md): before delegating, changing definitions or configuring the review team.
- [Borrowed from Pi](docs/pi-upstream.md): on Pi upgrades or changes to upstream couplings; includes upstream references.
- [Searching Pi's code](docs/pi-upstream.md#searching-pis-code): before reading Pi internals; where each package's types live and the `rg` command that finds them.

## Push permission

The top-level agent may commit verified work, land it and normally push the destination branch to `origin`
(`HazAT/ultimate`), public or private, without asking. `workspace submit` runs checks and pushes. Subagents commit
and report, never push. Never force-push, rewrite history or push secrets. This permission does not cover other
repositories, releases, publishing, deployments or GitHub issue/PR changes. A rejected push or remote advancement:
see [integration details](docs/worktrees.md#standing-permission-to-push-this-repository).

## Conventions

- Commits made through Ultimate's bash tool carry `Ultimate-Conversation: <id>`; find the conversation behind a commit with `git log --format=%(trailers:key=Ultimate-Conversation)`.
- Pi is the role model: minimal, readable, malleable. Prefer platform features and existing dependencies; justify every
  new dependency in its commit message.
- Public docs, READMEs, prompts, agent definitions, skills and code comments use generic names and examples ("the
  user", `my-app`, example addresses), never a real person's name, machine names, private repos or real IPs. LICENSE,
  upstream attributions and real repo URLs are exempt.
- `pnpm check` enforces import boundaries (`lint/ultimate.ts`, `vite.config.ts`). Its `pnpm deps` prints the
  dependency graph between extensions (imports plus `need`/`want`) and fails on a cycle, a loose `@earendil-works/*`
  pin or a core-tier extension that depends on an optional one; its `knip` fails on unused files, exports and
  dependencies: drop an `export` nothing imports, and add a new convention-loaded entry file to `knip.json`.
- Plain TypeScript, ESM, Node 26 runs `.ts` directly: erasable syntax only (no enums, namespaces, or parameter
  properties), relative imports end in `.ts`.
- Core server/web contracts live in `shared/protocol.ts`; extension-local types live with their extension.
- No implicit state machines: anything that moves through states gets one typed union of states (not flags, optional
  fields or untyped strings), one transition function as its only writer, one derivation every reader uses, and a
  table test over its transitions; other extensions change it through the owner's API.
- Pin `@earendil-works/*` packages to exact versions; Pi Durable is experimental.
- Tests live with what they test: one extension's in `extensions/<name>/test/` (browser-side ones in `test/web/`,
  spawned-process ones in `test/e2e/` there), and the core's (`server/`, `shared/`, `lib/`, `web/`, scripts, lint) plus
  those that exercise several extensions together in the top-level `test/`, which also keeps the shared helpers and
  fixtures (`test/helpers.ts`). `pnpm test extensions/<name>/` runs one extension's fast tests, `pnpm test:e2e
  extensions/<name>/` its e2e tests. An extension's `test/` folder is not part of the extension: saving a file there
  reloads nothing, and its imports are free of the extension import rules and stay out of `pnpm deps`.
- Checks: `pnpm check` (format, lint, types) and the tests covering your change must pass before a commit; the lander
  runs every suite. Run `pnpm fix` while you work: it formats with `vp fmt` (Vite+) first, so formatting never fails a
  check run. There is no prettier here: never run `pnpm exec prettier` or `npx prettier`, which downloads a prettier
  with the wrong config. Keep `pnpm test` fast: no real-time waits, no spawned processes (those go to a `test/e2e` folder), and
  fix or delete a flaky test rather than skipping it or raising its timeout. Lint enforces this outside the `test/e2e`
  folders (justified exceptions need a `fast-test-reason:` comment); poll with the real-deadline `until` from
  `test/helpers.ts`.
- Iterating (fork rule, #261292): between commits run `pnpm fix:changed` (or `pnpm check:changed`), which checks the
  files your branch changed and their direct importers in about half the time and RAM of the full check; run the full `pnpm fix` once before each commit or report.
- A scratch checkout of your own (a baseline, a throwaway experiment) gets `git worktree add` and its own
  `pnpm install --frozen-lockfile --offline` (seconds: packages hardlink from the store). Never symlink `node_modules`
  from another checkout: pnpm records the checkout it installed for and aborts trying to reinstall the shared folder.
- Scratch checkouts, pnpm stores, logs and other throwaway files go under `$TMPDIR` (`os.tmpdir()` in code), never a
  hard-coded `/tmp`, and are deleted when done: on some machines `/tmp` is RAM, and filling it gets the host killed.
- Every user-visible result is designed, not dumped: status and outcomes (a subagent report, a landing, a failure) get a
  renderer that matches the existing cards (see `extensions/subagents/messages.tsx`, `extensions/workspaces/log.tsx`),
  never plain Markdown in a message. Look at the running app and recent screenshots first, write the expected look into
  task descriptions, and check a worker's screenshots against it before accepting.

## Review quality

Rules about how agents behave live in prompts and agent definitions, not in code. Code checks protect only safety and
invalid states: data loss, security, impossible states. Lint enforces only rules the user explicitly approved. Where a
convention can be checked cheaply and with little noise, propose a check for it; once the user approves the rule,
`pnpm check` enforces it mechanically instead of a prompt asking for it.

A swallowed error needs a reason comment explaining why ignoring it is correct; `ultimate/no-silent-catch` enforces this for empty catch blocks and empty or `undefined`-returning `.catch` handlers.
Likewise, code that exists only because of something outside it (an upstream bug, a provider quirk, a helper that
papers over a library, an edge case found in the wild) carries a short comment at the code naming its origin (the
issue or PR URL, our PR number or the `#conversation`), what breaks without it and, if known, when it can go, so a
later agent can rethink it.

Reject slop and jargon: keep code and explanations direct, minimal, and grounded in evidence. No backward-compatibility
shims or speculative fallbacks; move forward and update callers. Commit tests for a feature's core path and one
regression test per bug that actually happened; they exercise behaviour and failure cases, never restate the
implementation. Prove edge cases once instead (a throwaway test or script you run and delete, an action call, a
preview check) and show the command and its output in the report; one-off migrations and retired shapes get no test.
