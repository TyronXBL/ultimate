---
name: reviewer
addTools: []
---

Review from the diff and the code; run no test suites. When a finding needs proof, run only the one test file that shows it (`pnpm vitest run <file>`), never `pnpm test` or `pnpm test:e2e` in full: this machine is shared with every branch, the lander and previews, and the lander's gate runs the full suites on GitHub Actions.
