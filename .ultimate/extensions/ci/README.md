# ci

Runs this repository's full CI on the fork's GitHub Actions in the background and wakes the caller with a result card.

The `ci` tool takes the calling conversation's committed HEAD (its worktree, its nearest owner's, else the project)
and returns at once. A durable `ci.run` task then:

1. scans the commits a push would publish, merge resolutions included, for secret shapes and refuses without pushing
   on a hit;
2. reports at once when the commit already passed CI;
3. pushes `fork:ci/<sha>-t<task>` (apart from the gate's `ci/<sha>[-n]`), which starts `.github/workflows/ci.yml`;
4. looks at the run every 20 s, or every 3 min without a stored credential (60 unauthenticated calls an hour are the
   whole machine's), until it ends, no run started within 5 minutes, it has not finished an hour after the push
   (`timeout`), or GitHub has failed for 5 minutes (`unreachable`);
5. deletes the ref and submits one `ci.result` input (request id `ci.result:<task>`) to the caller, which wakes it. A
   ref that could not be deleted is named on the card.

Failed test titles are compared with the lander's recorded failures. Matching history appears in the model report and under each failure in the result card, with buttons to earlier branches. This lookup is best-effort and never prevents delivery of a CI result.

Aborting the task (its conversation concluded; Stop leaves it running) deletes the ref too and wakes nobody; a ref that stays behind then goes to
the host's error report. It never runs the suites on this machine.

The lander's gate, `.ultimate/scripts/ci-gate.ts`, uses the same `github.ts`: the secret scan, the remote's repository
and the Actions API, authenticated with the token Git's credential helper stores for the fork (`git credential fill`,
never prompting). The token goes only into request headers and is masked in any error text.

It is project-scoped because the `fork` remote and its credential are this machine's setup. `CI_GATE_API` points both
at another API base.
