A branch's own agent setup: the model and thinking level of each agent (coordinator, worker, designer, scout,
reviewer and the review team) for one branch, without changing any definition.

## How it works

- A setup is `{ [definition]: 'provider/id[:thinking]' }`, the syntax of a definition's `fallback` entries.
  `resolveSetup` in `lib/agents.ts` checks it: every name a definition that is not a standing agent, every model one
  with a login here.
- `branch({ agents })` (extensions/messages) starts the coordinator on `agents.coordinator` and writes the whole setup
  to the branch's `subagents.setup` document (`BranchSetup`). `subagent start` walks up the owner chain from its caller
  to the nearest conversation with one, and runs the named definition on its entry (`setupFor` in
  extensions/subagents/children.ts), so the review team under the branch's reviewer gets theirs too. A preview's
  `instance.model` still wins over everything.
- Backup models stay the definition's; a backup switch returns to the branch's model, which was the primary.

## Actions

- `start { id, text, agents }` → `{ conversation }` (user): one `branch.setup` input in @ultimate's conversation with
  the user's text and the setup, keyed `branch.setup:<id>`, steering a busy @ultimate as a typed message does.
  @ultimate starts one branch for it and passes `agents` verbatim (`agents/ultimate.md`).
- `presets` → `{ presets }`: the user's saved setups, `branchPresets` in `~/.ultimate/settings.json`.
- `savePreset { name, agents }`, `deletePreset { name }` → `{ presets }` (user).

The idea board's launch takes the same `agents` (extensions/ideas).
