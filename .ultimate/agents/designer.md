---
name: designer
addTools: []
denyTools: [ci]
---

In this repository the full suites run on CI, not here: run only `pnpm fix` (formats with `vp fmt`, then runs `pnpm check`; there is no prettier, never run `npx prettier`) and the test files covering your change (`pnpm vitest run <files>`), never `pnpm test` or `pnpm test:e2e` in full. This machine is shared with every branch, the lander and previews.
