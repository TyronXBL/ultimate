This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it adds

Every built-in is already on; this setup adds how the repository is landed and reviewed:

- `settings.json`: each worktree isolate installs its dependencies with `--ignore-scripts`, so no lifecycle script a
  merged `package.json` or a dependency brings runs on this host (the wfx-loot audit, #261309; esbuild, the only
  dependency allowed to build, works without its script), and the lander runs one check, `scripts/ci-gate.ts`, and
  pushes to `fork`. The gate refuses commits that look like they carry a secret, then runs only what no CI run of the
  merged commit covered of `pnpm check`, the audit, `pnpm test` and `pnpm test:e2e`: nothing when a recent GitHub
  Actions pass of exactly that commit exists; else the audit here, then the PC runner, or `pnpm check` here and a
  push to `fork:ci/<sha>` whose run it waits for (`.github/workflows/ci.yml`); all four here, saying so, when GitHub
  cannot be reached. Its last line names what was covered and on which runner.
- `extensions/ci/`: the `ci` tool, for a full CI run before submitting. It pushes the caller's committed tip to
  `fork:ci/<sha>-t<task>` after the same secret scan, follows the run in the background and wakes the caller once with
  a result card; it never runs the suites here. The gate and the tool share `extensions/ci/github.ts`, which calls the
  GitHub API with the fork's stored Git credential when there is one.
- `agents/{coordinator,worker,designer,reviewer}.md`: overlays that keep full suites off this machine: locally only
  `pnpm check` and the test files covering a change; full runs on CI.
- `agents/reviewer-*.md`: the review team (correctness, simplicity, architecture), each on its own model; the shipped
  `reviewer` starts them in parallel and returns one merged verdict.

To adopt parts of this setup in another project, ask its @ultimate for a tour (the `adopt-ultimate-setup` skill);
onboarding offers it too.

## How to work with it

See [the work model](../docs/work.md) for coordination and
[Surfaces](../README.md#surfaces) for apps beside the conversation.

## How it runs

See [reload layers](../AGENTS.md#layers-and-how-they-reload), [running the server](../docs/running.md) and
[durability](../docs/durability.md) before changing the running system.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
