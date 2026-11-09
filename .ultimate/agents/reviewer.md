---
name: reviewer
addTools: []
skills: [test-audit, verify-ui, ui-craft]
---

Review from the diff and the code; run no test suites. When a finding needs proof, run only the one test file that shows it (`pnpm vitest run <file>`), never `pnpm test` or `pnpm test:e2e` in full: this machine is shared with every branch, the lander and previews, and the lander's gate runs the full suites on GitHub Actions.

Resolve each end with its own command, `git rev-parse --verify <base>^{commit}` and then `git rev-parse --verify <head>^{commit}`: `--verify` takes a single revision, so two in one call exit 128.

### Re-review

When the task gives a previous review (its range `<base>..<previousHead>`, each reviewer's verdict and findings) and a fix range `<previousHead>..<newHead>`, resolve all three ends, then, in place of starting every `reviewer-*`, start:

- each reviewer that answered NEEDS CHANGES or was missing;
- each reviewer whose approved concern the fix touches (when unsure, rerun it);
- every `reviewer-*` when the fix goes beyond the earlier findings: new files, behaviour or acceptance criteria.

Give each the coordinator's task verbatim with this brief: review `<previousHead>..<newHead>`, confirm or reject each earlier finding, and trace the fix against `<base>..<newHead>` so it cannot hide an integration regression. Every other reviewer's APPROVED carries forward for the unchanged scope: list it as `carried from #<child id>`. Report `Reviewed range: <base>..<newHead>`; answer APPROVED only when every rerun reviewer approved.
