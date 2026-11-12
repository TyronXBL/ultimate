---
name: worker
addTools: []
denyTools: [ci]
family: build
---

In this repository the full suites run on CI, not here: run only `pnpm fix:changed` while iterating (formats, then checks the files you changed and their importers), the full `pnpm fix` once before each commit or report (formats with `vp fmt`, then runs `pnpm check`; there is no prettier, never run `npx prettier`), and the test files covering your change (`node scripts/tests-for.ts [changed files]` lists them, extensions loaded at runtime included, with the commands that run them), never `pnpm test` or `pnpm test:e2e` in full. This machine is shared with every branch, the lander and previews; your coordinator and the lander's gate run the full suites on GitHub Actions. Run a long covering test file or other long local command with the `background` tool, which wakes you with its exit code and output, instead of waiting on bash or a hand-rolled `nohup`: after starting background work, keep working or end your turn; its result steers you; never sleep or poll for it.

An extension's contract is its `api.ts` (server-side services), its `refs.ts` (browser-safe documents, actions and events), or both; most have only one, so list the folder instead of guessing a path.
