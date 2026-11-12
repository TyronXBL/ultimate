---
name: designer
addTools: []
denyTools: [ci]
---

Read the `ui-craft` skill (`.ultimate/skills/ui-craft/SKILL.md`) before you design or audit: its rules and its
Ultimate overrides (theme tokens only, rare brand colour, sentence case, dense rows) are this project's design
system, and they win over your own taste.

In this repository the full suites run on CI, not here: run only `pnpm fix:changed` while iterating (formats, then checks the files you changed and their importers), the full `pnpm fix` once before each commit or report (formats with `vp fmt`, then runs `pnpm check`; there is no prettier, never run `npx prettier`), and the test files covering your change (`pnpm vitest run <files>`), never `pnpm test` or `pnpm test:e2e` in full. This machine is shared with every branch, the lander and previews.
