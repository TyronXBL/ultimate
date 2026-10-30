# ci

Runs this repository's full CI in the background and wakes the caller with a result card: on the PC runner when this
machine has a `pc` remote, else on the fork's GitHub Actions.

The `ci` tool takes the calling conversation's committed HEAD (its worktree, its nearest owner's, else the project)
and returns at once. A durable `ci.run` task then:

1. scans the commits a push would publish, merge resolutions included, for secret shapes and refuses without pushing
   on a hit;
2. with a `pc` remote, runs `check`, `test` and `test:e2e` on the PC (`pc.ts`, set up as in
   `.ultimate/ci-runner/README.md`). Its pass or fail is the result, named `on <host>` on the card. A PC that gives no
   verdict (unreachable, busy, install failed) hands over to the steps below at once, and the card says why;
3. reports at once when the commit already passed CI on GitHub;
4. pushes `fork:ci/<sha>-t<task>` (apart from the gate's `ci/<sha>[-n]`), which starts `.github/workflows/ci.yml`;
5. looks at the run every 20 s, or every 3 min without a stored credential (60 unauthenticated calls an hour are the
   whole machine's), until it ends, no run started within 5 minutes, it has not finished an hour after the push
   (`timeout`), or GitHub has failed for 5 minutes (`unreachable`);
6. deletes the ref and submits one `ci.result` input (request id `ci.result:<task>`) to the caller, which wakes it. A
   ref that could not be deleted is named on the card.

Each failing test is looked up in the lander's record (`workspaces.failing`, without the caller's own submissions): one
that also failed at other branches' landings says so in the model text and on the card, with links to those branches.
A failed lookup leaves that out and delivers the result as it is.

Aborting the task (its conversation concluded; Stop leaves it running) deletes the ref too and wakes nobody; a ref that stays behind then goes to
the host's error report. It never runs the suites on this machine.

The lander's gate, `.ultimate/scripts/ci-gate.ts`, tries the same PC first (`test`, `test:e2e`) and uses the same
`github.ts`: the secret scan, the remote's repository
and the Actions API, authenticated with the token Git's credential helper stores for the fork (`git credential fill`,
never prompting). The token goes only into request headers and is masked in any error text.

It is project-scoped because the `fork` remote and its credential are this machine's setup. `CI_GATE_API` points both
at another API base.
