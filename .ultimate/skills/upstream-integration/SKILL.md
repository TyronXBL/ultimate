---
name: upstream-integration
description: Merge upstream `origin/main` into this fork's main in a branch worktree, keep the fork's behaviour, resolve conflicts, record which tip CI tested, and say what the landing needs (install, restart, a human `pnpm start`). Use for the daily upstream merge or whenever a branch merges `origin/main`.
---

# Merge upstream into the fork

`origin` is upstream; main carries the fork's own commits on top. Merge, never replace: the fork's history and
its features stay.

## 1. Merge

In your branch worktree:

```bash
git fetch origin --quiet
git log --oneline HEAD..origin/main      # what upstream brings
git merge origin/main -m 'Merge origin/main: <the few things it brings>'
```

A normal merge only: never rebase, reset, cherry-pick upstream's commits or force anything. A merge that goes
wrong is aborted (`git merge --abort`) and started again, not rewritten.

## 2. Know what the fork keeps

Don't work from a remembered list; ask Git which areas are the fork's:

```bash
git log --oneline --no-merges origin/main..HEAD^1 -- <path>   # the fork's commits on a path
git log -1 --format='%(trailers:key=Ultimate-Conversation)' <sha>  # the conversation behind one
```

Read the README of each area those commits touch (`extensions/<name>/README.md`, `.ultimate/README.md`,
`docs/pi-upstream.md` for patches and upstream couplings) before resolving it. Keep the fork's behaviour unless
upstream clearly replaces it with the same thing; then take upstream's, delete the fork's copy and its tests, and
say so in the report.

## 3. Conflict checklist

For each file in `git diff --name-only --diff-filter=U`:

- Read both intents: `git log --oneline HEAD^1...origin/main -- <file>` and the commits' messages, not just the hunks.
- Combine both behaviours; where they really exclude each other, it is a decision for @ultimate, not a guess.
- A rename or move upstream: carry the fork's change to the new place and update its imports.
- A contract upstream changed (a service, document, event, tool list): find the fork's callers and the test doubles
  that implement it (`rg <name> test/ extensions/`); upstream's new tests mocking a module the fork extended need the
  fork's additions too.
- No markers left: `rg -n '^(<<<<<<<|=======|>>>>>>>)( |$)'`.
- `rerere` is on in the clone (`git config rerere.enabled true`, shared by every worktree), so a conflict resolved in
  an earlier merge is filled in again: `git merge` says `Resolved '<file>' using previous resolution.`. Such a file
  has no markers but stays in the `U` list until `git add`, and gets the same reading, since the code around the old
  resolution may have moved. A wrong one is undone with `git rerere forget <file>` and `git checkout -m <file>`, then
  resolved again.

## 4. Lockfile and patches

- Never hand-merge `pnpm-lock.yaml`: resolve `package.json` and `pnpm-workspace.yaml`, take either lockfile side,
  then regenerate it with `pnpm install --no-frozen-lockfile` (through `background`; `--offline` first, which
  fails only when a new package is not in the store yet).
- A patched package (`patchedDependencies` in `pnpm-workspace.yaml`) whose version upstream moved fails the install:
  drop the patch when upstream ships the fix, else redo it on the new version (`pnpm patch <pkg>@<version>`, apply
  the change, `pnpm patch-commit`), and update its entry in `docs/pi-upstream.md`.
- `@earendil-works/*` stays on exact versions.

## 5. Verify, and record the tip

`pnpm fix` and the covering tests (`node scripts/tests-for.ts $(git diff --name-only HEAD^1 HEAD)`) through
`background`, then the `ci` tool for the full run. A CI result names its commit: compare it with `git rev-parse HEAD`
before you cite it. Every fix commit after the merge moves the tip, and an older tip's green run proves nothing about
it: run `ci` again, or say which commits CI did not cover. The report names the tip CI tested, in full.

## 6. Say what the landing needs

Check `git diff --name-only HEAD^1 HEAD` and put it in the report for @ultimate:

- `extensions/`, `web/`, `agents/`, skills: live, nothing to do.
- `pnpm-lock.yaml`: the host installs on its next restart; a running core holds server facet reloads until then.
- `server/` or `shared/`: @ultimate calls `restart` after the landing, and every other instance on the same clone
  needs its own (`docs/running.md`).
- `bin/`: only a human `pnpm start` applies it; ask the user.

## RAM floor

The machine keeps 3 GB free: installs, `pnpm fix` and test files go through `background`, one at a time; the full
suites run on CI, never here.
