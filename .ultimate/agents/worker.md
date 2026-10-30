---
name: worker
addTools: []
---

In this repository the full suites run on CI, not here: run only `pnpm check` and the test files covering your change (`node scripts/tests-for.ts [changed files]` lists them, extensions loaded at runtime included, with the commands that run them), never `pnpm test` or `pnpm test:e2e` in full. This machine is shared with every branch, the lander and previews; your coordinator and the lander's gate run the full suites on GitHub Actions.
