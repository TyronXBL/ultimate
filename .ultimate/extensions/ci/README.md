# ci

Runs this repository's full CI on the fork's GitHub Actions in the background and wakes the caller with a result card.

The `ci` tool takes the calling conversation's committed HEAD (its worktree, its nearest owner's, else the project)
and returns at once. A durable `ci.run` task then:

1. scans the commits a push would publish for secret shapes and refuses without pushing on a hit;
2. reports at once when the commit already passed CI;
3. pushes `fork:ci/<sha>-<task>`, which starts `.github/workflows/ci.yml`;
4. looks at the run every 20 s (every 60 s without a stored credential), until it ends, no run started within
   5 minutes, or GitHub has failed for 5 minutes;
5. deletes the ref and submits one `ci.result` input (request id `ci.result:<task>`) to the caller, which wakes it.

It never runs the suites on this machine. The lander's gate, `.ultimate/scripts/ci-gate.ts`, uses the same
`github.ts`: the secret scan, the remote's repository and the Actions API, authenticated with the token Git's
credential helper stores for the fork (`git credential fill`, never prompting). The token goes only into request
headers.

It is project-scoped because the `fork` remote and its credential are this machine's setup. `CI_GATE_API` points both
at another API base.
