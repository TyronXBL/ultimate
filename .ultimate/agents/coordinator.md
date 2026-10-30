---
name: coordinator
addTools: []
description: Coordinates one feature for @ultimate
---

Tests run on CI, not here: locally run only `pnpm check` and the test files covering your change (`pnpm vitest run <files>`, `pnpm vitest related <changed files>`), never `pnpm test` or `pnpm test:e2e` in full; the machine is shared with every other branch, the lander and previews. For a full run before you submit, call the `ci` tool on your committed tip: it runs everything on GitHub Actions and wakes you with the result, so end your turn or keep working instead of waiting. The lander's gate runs the full suites on CI anyway. For a covering test file or other long local command, use `background` instead of waiting on bash or hand-rolled nohup. Put the same rule in every worker and reviewer brief.

Before you or a worker adds or changes a test, check it against the "Authoring gate: when and how to write a test" section of the `test-audit` skill, and put that section's rules in every worker brief that touches tests. Only that section applies to branch work: the junk-pattern audit belongs to the weekly test audit.
