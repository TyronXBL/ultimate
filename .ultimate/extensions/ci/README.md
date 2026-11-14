# ci

Runs this repository's full CI in the background and wakes the caller with a result card: on the PC runner when this
machine has a `pc` remote, else on the fork's GitHub Actions.

The `ci` tool takes the calling conversation's committed HEAD (its worktree, its nearest owner's, else the project)
and returns at once. A checkout with staged, unstaged or untracked changes is refused with the paths and "commit
first, in its own tool round": a `git commit` in the same tool round as `ci` used to lose the race, and CI tested the
commit before it. HEAD is read after that check; the card names the exact sha it tested either way. It commits,
stashes and cleans nothing. A durable `ci.run` task then:

1. scans the commits a push would publish, merge resolutions included, for secret shapes and refuses without pushing
   on a hit;
2. with a `pc` remote, runs `check`, `test` and `test:e2e` on the PC (`pc.ts`, set up as in
   `.ultimate/ci-runner/README.md`). Its pass or fail is the result, named `on <host>` on the card. A PC that gives no
   verdict (unreachable, busy, install failed) hands over to the steps below at once, and the card says why;
3. decides by the lander gate's rule (`gatePlan` in `github.ts`) what the commit's runs on GitHub mean: it reports at
   once when the commit passed and no run of it ended any other way, and waits for a run of it still under way instead
   of pushing a second one;
4. else pushes `fork:ci/<sha>-t<task>` (apart from the gate's `ci/<sha>[-n]`), which starts `.github/workflows/ci.yml`;
5. looks at the run every 20 s, or every 3 min without a stored credential (60 unauthenticated calls an hour are the
   whole machine's), until it ends, no run started within 5 minutes, it has not finished an hour after the push
   (`timeout`), or GitHub has failed for 5 minutes (`unreachable`). A run whose jobs GitHub did not start (the
   annotation "The job was not started because … your spending limit needs to be increased", once a private repository
   on a $0 budget spent the month's minutes) is `no-run` with GitHub's reason, not a failure of the code, unless another
   job ran and failed, which is a verdict. Annotations that cannot be read count as GitHub failing;
6. deletes the ref and submits one `ci.result` input (request id `ci.result:<task>`) to the caller, which wakes it (a
   note that starts no run while the caller is concluded: the conversations service's `resultIn`). A ref that could
   not be deleted is named on the card.

Each failing test is looked up in the lander's record (`workspaces.failing`, without the caller's own submissions): one
that also failed at other branches' landings says so in the model text and on the card, with links to those branches.
A failed lookup leaves that out and delivers the result as it is.

Aborting the task (its conversation concluded; Stop leaves it running) deletes the ref too and wakes nobody; a ref that stays behind then goes to
the host's error report. It never runs the suites on this machine.

The lander's gate, `.ultimate/scripts/ci-gate.ts`, is this project's only lander check (#273712): it decides which of
`pnpm check`, `pnpm audit --audit-level high`, `pnpm test` and `pnpm test:e2e` still have to run, and its last line
names what was covered and on which runner. It first looks for a pass it may reuse (#205147): a GitHub run of
exactly the commit it checks that passed, finished on GitHub at most 6 hours ago (`REUSE_MS`), with no run of that
commit that failed or was cancelled (`gatePlan`, `reusable` in `github.ts`). Such a run's first shard ran the check and
the audit too, so nothing runs here. A run in progress is never a pass: the gate waits for it, and runs nothing here
or on the PC. This lookup tries GitHub once per call. A
reuse prints a `lander-reused:` line with the run's origin (runner, URL, commit, finish time, duration), which the
lander records as a `reused` check on the landing card; otherwise the gate's last line says why it ran fresh ("tip CI
had failed: <url>", "no CI run of <sha>", the pass's age). With no run to reuse or wait for, it runs the audit here
(light, at once), then asks the same PC for `check`, `test` and `test:e2e`, whose verdict is final; without a PC or a
verdict from it, it runs `pnpm check` here, failing before any push, then pushes to GitHub Actions through the same
`github.ts`. When GitHub gives no verdict (unreachable, or jobs not started for billing) it runs on this machine
whichever of the audit and the check has not run yet, then `pnpm test` and `pnpm test:e2e`. The check and the suites
run here as jobs of the machine's heavy-work queue once their turn comes and the RAM floor admits them
(`lib/slot.ts`; RAM short at the head of the line fails the gate after 10 min); the fallback prints a
`CI GATE FALLBACK` banner naming why. `github.ts` holds the secret scan, the remote's repository
and the Actions API, authenticated with the token Git's credential helper stores for the fork (`git credential fill`,
never prompting). The token goes only into request headers and is masked in any error text.

It is project-scoped because the `fork` remote and its credential are this machine's setup. `CI_GATE_API` points both
at another API base.
