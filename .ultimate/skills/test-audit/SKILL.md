---
name: test-audit
description: Decide whether a test should exist, and audit an area's tests for low-value proof (duplicate, implementation-coupled or test-only seams). Use when writing, changing or reviewing tests, and for the weekly test audit of one area.
---

# Test audit

Adapted from OpenClaw's test-audit skill for this repository. The rules in AGENTS.md ("Checks", "Review quality")
come first; this skill applies them.

## Authoring gate: when and how to write a test

Before adding or changing a test, answer:

1. **What does it protect?** An observable behaviour, an invariant or an independent contract (an action's args and
   result, a document shape, an event, a settings file, storage, a prompt the model reads). Not the implementation.
2. **Which regression makes it fail?** Name a credible one. If none, don't write it.
3. **Why doesn't existing proof catch it?** Each contract has one owning test at its strongest boundary. A second
   layer needs its own transport or lifecycle risk. Extend an existing table or fixture rather than adding a near
   copy.
4. **Does it need a test-only seam?** An export, flag, wrapper or injection hook with no production caller: move the
   proof to the real boundary instead.

When:

- Commit tests for a feature's **core path**, and **one regression test per bug that actually happened**, which must
  fail before the fix for the intended reason and pass after it.
- Prove every other edge case **once**: a throwaway test, script, action call or preview check, shown in the report
  and deleted. One-off migrations and retired shapes get no test.
- A behaviour-preserving refactor must not break a test.

How:

- `test/*.test.ts` is the fast suite (`pnpm test`): no real-time waits, no spawned processes, no raised timeouts
  (lint: `ultimate/no-test-timeout`, `ultimate/no-real-wait-in-fast-tests`, `ultimate/no-local-test-polling`). Poll
  with `until` from `test/helpers.ts`.
- Processes, real servers, browsers and timing go in `test/e2e`.
- A full `fauxServer` costs seconds: reuse one per file where tests don't need fresh state, close it when done, and
  prefer a unit-level boundary when the contract allows it.
- Fix or delete a flaky test; never skip it.

## Junk patterns (audit candidates)

- Self-comparisons, or expected values produced by the code under test.
- Copied inventories (lists of names, keys or files that just restate the source) and source greps.
- Assertions on call shapes, internal function order or mocks that supply the behaviour being asserted.
- The same contract proved again at another layer with no distinct risk.
- Fixtures that fabricate receipts, ordering or persistence the real code never writes.
- Negative controls that pass for the wrong reason; test names that don't match what runs.
- Production exports, flags or hooks that exist only for tests.

## Keep

Independent contracts stay even when static or slow: action and document APIs, protocol (`shared/protocol.ts`),
settings and agent-definition formats, storage, durability and replay, migrations, security
(`server/request-security.ts`, secrets, tailscale admission), prompts the model reads, the extension dependency
graph, and observable ordering. A failing baseline may be a bug to repair, not a test to delete.

## Weekly audit of one area

1. When choosing the area, read the tests that keep failing at landing with codemode
   `ultimate.action('workspaces', 'failing', { limit: 20 })` and prefer an area whose tests fail for many branches.
   Read the area's tests and the code they cover, and its history (`git log --follow`). Measure the area's runtime
   (`pnpm test <files>`, median of 3).
2. For each candidate, record: the junk pattern, the contract it claims, **which remaining test still proves that
   contract** (file:line), and its cost.
3. Build nothing. Return one proposal to @ultimate, grouped into coherent batches by owner, never chasing deletion
   counts:
   - delete, merge into a table, or move to the real boundary;
   - production seams that would go with them;
   - test and production lines removed, and the seconds saved;
   - contracts deliberately kept, and why.
     End with numbered decisions, one per batch.
4. After the user approves, implement the chosen batches with workers. Run `pnpm check`, the area's tests and their
   siblings, then review and submit.
