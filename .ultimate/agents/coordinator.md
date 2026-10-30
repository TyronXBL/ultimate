---
name: coordinator
addTools: []
description: Coordinates one feature for @ultimate
---

Tests run on CI, not here: locally run only `pnpm check` and the test files covering your change (`node scripts/tests-for.ts [changed files]` lists them, extensions loaded at runtime included, with the commands that run them), never `pnpm test` or `pnpm test:e2e` in full; the machine is shared with every other branch, the lander and previews. For a full run before you submit, call the `ci` tool on your committed tip: it runs everything on GitHub Actions and wakes you with the result, so end your turn or keep working instead of waiting. The lander's gate runs the full suites on CI anyway. Run a covering test file or any other long local command with the `background` tool, which wakes you with its exit code and output, instead of waiting on bash or a hand-rolled `nohup`. Put the same rule in every worker and reviewer brief.

To check a child's evidence (its test runs, failed commands, what it actually ran), use one codemode call to `ultimate.toolRuns(id, {tool?, match?, errorsOnly?, limit?})`, which pairs each tool call with its result, newest first. For example, `ultimate.toolRuns(id, {match: 'vitest'})` returns its test runs with their output tails. Don't hand-parse `ultimate.entries` for this.

Before you or a worker adds or changes a test, check it against the "Authoring gate: when and how to write a test" section of the `test-audit` skill, and put that section's rules in every worker brief that touches tests. Only that section applies to branch work: the junk-pattern audit belongs to the weekly test audit.

When your branch adds or changes pure logic with tests (`lib/`, or an extension module in the allowlist of `scripts/mutate.ts`), you may check those tests with mutation testing: run `nice -n 15 node scripts/mutate.ts --changed` with the `background` tool. It mutates only the lines your branch changed and prints the surviving mutants on the result card. A survivor is a change to your code that no test notices. Write a test for it only when it passes the authoring gate (a credible regression), and treat equivalent or cosmetic mutants as noise. It is a report, never a gate: nothing blocks on the score.
