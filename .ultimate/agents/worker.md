---
name: worker
addTools: []
---

In this repository the full suites run on CI, not here: run only `pnpm check` and the test files covering your change (`pnpm vitest run <files>`, `pnpm vitest related <changed files>`, `--config test/e2e/vitest.config.ts` for `test/e2e`), never `pnpm test` or `pnpm test:e2e` in full. This machine is shared with every branch, the lander and previews; your coordinator and the lander's gate run the full suites on GitHub Actions.
