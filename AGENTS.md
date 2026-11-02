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

- `extensions/<name>/web.tsx`: UI of an extension (slots, panels, surfaces, tool and entry renderers, commands). Vite
  hot reload, instantly, without a page reload; a broken facet shows an error card, the rest keeps running.
- `extensions/<name>/server.ts`: agent behaviour (system prompt, tools, hooks; Pi Durable extensions). Reinstalled on
  save: running tool calls finish on the old code, the next call uses the new code.
- `extensions/<name>/api.ts`: its contract for other extensions; `export const tier = 'core'` puts it in the
  always-on core tier, which depends only on the core tier, one way
  ([docs/extensions.md](docs/extensions.md#core-tier)). Goes live with the facets that import it.
- `lib/`: pure helpers extensions share (exec, git, JSON and settings files, secret reads); no state, no extension
  imports. Goes live like the extensions that import it.
- `web/`: the web core (surface host with primitives, SDK in `web/src/sdk`, transcript, composer, palette). Vite hot
  reload, instantly.
- `agents/`: subagent definitions (Markdown with frontmatter), read at each use.
- `server/`, `shared/`: core plumbing (harness, storage, API, Vite hookup). Call the `restart` tool: a new process
  boots and type-checks next to the old one; if it fails you get the error and the old process keeps running, if it
  succeeds the run resumes in the new process.
- `bin/`: the supervisor. Only a human restart (`pnpm start`) applies it; keep it tiny and change it rarely.

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart.
A surface is a full-screen app the user switches to (header, ⌘K, `mod+1…9`); the conversation itself is the built-in
`agent` surface, and a project's apps go in `<project>/.ultimate/extensions/` (see "Surfaces" in the guide).
New UI is a new extension folder, not a change to `web/`: follow the `write-extension` skill, which points into
[extensions/README.md](extensions/README.md), and copy the closest existing one (`status-line`, `coding-tools`).

## Developer reference — read when needed

- [Architecture diagrams](docs/architecture/index.html): five pictures of how the browser, server, Pi Durable, extensions, events and agents fit together.
- [Running the server](docs/running.md): before starting, debugging or testing a server or core swap.
- [Worktrees and integration](docs/worktrees.md): before previewing an isolate, landing or recovering a rejected push.
- [Discovery and settings](docs/settings.md): before changing configuration, trust, resources or `summaryModel` (titles, summaries, reply summaries and tree abstracts).
- [Durability](docs/durability.md): before changing persistence, replay or durable UI state.
- [Extension mechanics and introspection](docs/extensions.md): before wiring facets, documents, events or runtime inspection.
- [Subagents](docs/subagents.md): before delegating, changing definitions or configuring the review team.
- [Borrowed from Pi](docs/pi-upstream.md): on Pi upgrades or changes to upstream couplings; includes upstream references.

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
- Pin `@earendil-works/*` packages to exact versions; Pi Durable is experimental.
- Checks: `pnpm check` (format, lint, types) and the tests covering your change must pass before a commit; the lander
  runs every suite. Run `pnpm fix` while you work: it formats with `vp fmt` (Vite+) first, so formatting never fails a
  check run. There is no prettier here: never run `pnpm exec prettier` or `npx prettier`, which downloads a prettier
  with the wrong config. Keep `pnpm test` fast: no real-time waits, no spawned processes (those go to `test/e2e`), and
  fix or delete a flaky test rather than skipping it or raising its timeout. Lint enforces this outside `test/e2e`
  (justified exceptions need a `fast-test-reason:` comment); poll with the real-deadline `until` from
  `test/helpers.ts`.
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
`pnpm check` enforces it mechanically instead of a prompt asking for it. A swallowed error needs a reason comment
explaining why ignoring it is correct (`ultimate/no-silent-catch`).

Reject slop and jargon: keep code and explanations direct, minimal, and grounded in evidence. No backward-compatibility
shims or speculative fallbacks; move forward and update callers. Commit tests for a feature's core path and one
regression test per bug that actually happened; they exercise behaviour and failure cases, never restate the
implementation. Prove edge cases once instead (a throwaway test or script you run and delete, an action call, a
preview check) and show the command and its output in the report; one-off migrations and retired shapes get no test.
