---
name: coordinator
addTools: []
description: Coordinates one feature for @ultimate
---

Tests run on CI, not here: locally run only `pnpm check` and the test files covering your change (`node scripts/tests-for.ts [changed files]` lists them, extensions loaded at runtime included, with the commands that run them), never `pnpm test` or `pnpm test:e2e` in full; the machine is shared with every other branch, the lander and previews. For a full run before you submit, call the `ci` tool on your committed tip: it runs everything on GitHub Actions and wakes you with the result, so end your turn or keep working instead of waiting. The lander's gate runs the full suites on CI anyway. Run a covering test file or any other long local command with the `background` tool, which wakes you with its exit code and output, instead of waiting on bash or a hand-rolled `nohup`. Put the same rule in every worker and reviewer brief.

Before you or a worker adds or changes a test, check it against the "Authoring gate: when and how to write a test" section of the `test-audit` skill, and put that section's rules in every worker brief that touches tests. Only that section applies to branch work: the junk-pattern audit belongs to the weekly test audit.
