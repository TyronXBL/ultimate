---
name: security-audit
description: Audit a codebase's trust boundaries for vulnerabilities on request, repeatably - pinned revision, coverage ledger across runs, a fresh verifier refuting each candidate, schema-checked findings, an offline sandbox for any execution. Use when the user asks for a security audit or security review of Ultimate or a project's code, to re-run or extend an earlier audit, or to triage one suspected vulnerability.
license: MIT; adapted from cloudflare/security-audit-skill at c1c8a8c, see upstream/SOURCE.md
---

# Security audit

Find vulnerabilities that cross a real trust boundary, prove each one as far as source and a sandboxed local check
allow, and hand the owner a verified record with the smallest fix. This adapts Cloudflare's MIT security-audit skill,
kept byte-identical in [upstream/](upstream/) (phase prompts, attack classes, domain companions, findings schema and
validators). This file decides how it runs in Ultimate and wins every conflict with `upstream/`.

## What a request authorizes

The skill runs on demand only: never schedule it, never attach it to an automation, never start it after installing
or changing it. An audit request authorizes reading the scoped source at its pinned revision, delegating to
subagents, writing the run folder, and running target code through `sandbox.ts run` only.

It does not authorize, and each needs its own go from the user: running exploits or downloaded proof-of-concept code;
scanning or sending traffic to anything outside the machine (deployed services, other users' instances); contacting
other projects; uploading code; enabling automations; logging into or creating accounts; spending money or paid API
quota beyond the agents' own model calls; installing dependencies or running a target's install scripts.

Keep secrets out of the audit. Never read `~/.ultimate/secrets.json`, provider auth files, SSH keys or any other
credential. A secret found in source is cited as `path:line` and its kind ("a GitHub token"), never its value, in
every finding, artifact, report and message.

## Modes

- **Guidance**: a security question, one suspected issue, or triage of a report. Use the parts that fit (an attack
  class, the candidate gate in `upstream/HUNTING.md`, the verifier prompt) with no run folder and no ledger. Even
  here, target code runs only through `sandbox.ts run`.
- **Full audit**: the user asks to audit or security-review a codebase or a named part of it, or to re-run one. Run
  every step below.

When a request could be either, ask one question before creating any file.

## Set up a full audit

1. **Scope.** For Ultimate, the default scope is the in-scope list of `SECURITY.md`, starting from
   `server/request-security.ts` (request and header policy), `extensions/browser/` (browser tools), `lib/secrets.ts`
   and `extensions/secrets/` (secret storage), `extensions/files/` (the Files viewer), and `server/project-setup.ts`
   with `server/skills.ts` (project trust for skills, agents and extensions). For another project the user names the
   scope. Record it as `scope_paths`; seed everything else you discover as `out_of_scope` units, never `covered`.
2. **Profile.** `quick` by default (one hunter wave, one coverage critic, one fresh verifier per candidate);
   `standard` when the user asks for it; `deep` only with the user's go, for its cost. Tell the user the profile, the
   scope and the planned number of agents before the first wave, and record that number as `budget`.
3. **Pinned revision.** Resolve the full commit with `git rev-parse --verify <rev>^{commit}`; uncommitted changes are
   not reviewed (record whether the checkout was dirty). Snapshot it:
   `node <skill-dir>/sandbox.ts snapshot <repo> <commit> <run>/target`. It writes the tracked bytes of that commit
   only (no untracked files, no filters or hooks; symlinks leaving the tree are dropped and listed) and
   `<run>/target.snapshot.json`. Every agent reads source from `<run>/target`; findings use repository-relative paths.
4. **Run folder.** `<run>` is `~/.ultimate/projects/<project>/security-audit/run-<N>/`, the project's state folder
   beside `research/`, with the next unused `<N>`; never inside the target. Earlier `run-*` folders are the prior
   runs: read their `coverage-ledger.json` and `findings.json` as `upstream/SKILL.md` "Coverage and prior runs" and
   `upstream/RECONNAISSANCE.md` "Prior-run input" describe. With none, say so in the report.
5. **Sandbox gate.** Run `node <skill-dir>/sandbox.ts selftest` with the `background` tool and record its verdict in
   `run-metadata.json` as `sandbox` ("selftest passed" or the failing checks). When it fails, no target code runs in
   this run: a candidate that needs execution stays `needs_validation` with the blocker
   "sandbox selftest failed: <check>", the report says so, and you ask @ultimate for the missing capability rather
   than working around it.
6. **Metadata.** Write `run-metadata.json` as `upstream/SKILL.md` "Full audit setup" lists, with
   `execution_policy: "sandboxed-source-and-local-only"`, the commit and the sandbox verdict.

## Roles

- **Parent**: you, the conversation running the audit; the only writer of the run files.
- **Task tool**: `subagent start` without `fork`, so every agent starts fresh. Run one wave at a time.
- **`research` agents** (reconnaissance, coverage critics, Phase 5 record checks): `scout`, or an agent made on the
  fly with `tools: ["read", "bash"]` when it needs a stronger model.
- **`general` agents** (hunters): made on the fly, `family: "review"`, `thinking: "high"`,
  `tools: ["read", "bash", "background"]`. `bash` is for `rg` and `git`; `background` is for `sandbox.ts run`.
- **Verifiers**: one per candidate, made on the fly, `tools: ["read", "bash", "background"]`, on a different model
  from the hunter that found it: read the families' models with codemode `ultimate.models()` or the Agents panel and
  pass that `family`, or a `model`. When only one model is available, the report says the verifiers were independent
  by context only. The task carries only what
  `upstream/VALIDATION-AND-REPORTING.md` Phase 3 lists, never the hunter's conversation or another verifier's
  conclusion. Its answer is one JSON object; a prose-wrapped answer is discarded and re-run, never repaired.

## Execution

Target-controlled code (a build, a test, a fixture, a harness) runs only as:

```sh
node <skill-dir>/sandbox.ts run --target <run>/target \
  --artifact <run>/agents/<agent-id>/artifacts/<check>.json [--deps <checkout>/node_modules] [--cwd <sub/dir>] \
  [--memory 1024] [--tasks 128] [--cpu 100] [--timeout 300] [--scratch 256] [--env NAME=dummy] -- <command> [args...]
```

Start it with the `background` tool, which waits for free RAM, and keep one sandbox run per agent at a time. The
command runs in a bubblewrap sandbox inside a systemd user scope: its own network namespace (loopback only, the host's loopback services unreachable), an empty environment
plus the `--env` values, the snapshot and the toolchain read-only, no home folder, `/run` or `/sys`, and writes only
to a scratch tmpfs (`HOME`, `TMPDIR` and `/tmp` point into it) that is discarded at exit. The scope enforces memory
(no swap), process, CPU and wall-clock limits, and the helper checks them from inside before anything starts. A
snapshot whose files changed since `snapshot` made it is refused. Any failure exits 125 without running the command,
and there is no unsandboxed fallback; the transcript's `started` field tells that apart from a command that itself
exits 124 or 125.

`--deps` mounts an existing `node_modules` read-only; the sandbox cannot install anything. A tool that writes beside
the source (a cache, a build output) fails on the read-only target: point it at `$TMPDIR` with its own option.

The helper, outside the sandbox, writes the transcript to `--artifact` (created exclusively): the command, the
commit, the limits, the `--env` values, the exit and the bounded output, with home-folder paths written as `~` and no
ambient variable.
Nothing in scratch is ever promoted, so `upstream/`'s artifact promotion procedure does not apply; that transcript is
the `local` check's `artifact` in the ledger. Wherever an upstream prompt says to copy the promotion procedure
verbatim, copy this block instead:

```text
Execution evidence (replaces artifact promotion):
Run target code only with `node <skill-dir>/sandbox.ts run --target <run>/target
--artifact <run>/agents/<your-agent-id>/artifacts/<check>.json [...] -- <command>`.
It enforces no network, an empty environment, a read-only target and toolchain,
scratch-only writes and resource limits, or refuses without running anything.
Scratch is discarded at exit; nothing in it is evidence. The artifact transcript
the helper writes is your evidence: cite it as the check's artifact as
agents/<your-agent-id>/artifacts/<check>.json, never in a record's trace or
evidence, whose paths are repository-relative. If the helper refuses, or the
transcript says "started": false, do not run the command another way: return
needs_validation with the helper's message as the blocker. Use only dummy values
in --env.
```

Limits to state plainly in the report: only the target process is isolated (the agents, their tools and model calls
keep network access); there is no seccomp filter, so the kernel's system-call surface is that of any unprivileged
process; the sandbox has no `/etc/passwd`, resolver configuration or `/etc/ssl`, so tools that need them fail
visibly.

## Workflow

Follow `upstream/SKILL.md` "Full audit workflow" with its phase files, under these rules:

- **Reconnaissance**: launch the four agents of `upstream/RECONNAISSANCE.md` in parallel on `<run>/target`. Agent 1d's
  sandbox and promotion questions are answered by the selftest; drop them from its prompt.
- **Obvious things**: every run, scoped and `quick` ones included, has one `ATTACK-CLASSES.md#Obvious things` unit
  over the whole scope, and its hunter answers every item of that block. Search for secrets with `rg -l` or
  `rg -n -o '<pattern-name>'` so values never print. Known-CVE lookups need the network: record them `out_of_scope`
  and name the project's dependency audit instead (for Ultimate, the weekly security check automation).
- **Hunting and validation**: `upstream/HUNTING.md` and `upstream/VALIDATION-AND-REPORTING.md`, with the execution
  block above in place of the promotion block.
- **Validators** after seeding, after every ledger or findings update, and before the report:
  `node <skill-dir>/upstream/validate-coverage-ledger.cjs <run>/coverage-ledger.json` and
  `node <skill-dir>/upstream/validate-findings.cjs <run>/findings.json`. Passing proves shape and consistency only.
- **Severity**: only `confirmed` records get one, capped by the impact the run demonstrated. Calibrate against
  `SECURITY.md`: the server binds loopback and serves one operator, so a finding names a lower-trust principal from
  its in-scope list (a web page, a remote server, a repository, a tailnet login) and its out-of-scope list rejects a
  candidate. Existing controls (`server/request-security.ts`, project trust, the Chromium sandbox, `frame-ancestors`)
  are controls the verifier reconstructs, not details to skip.
- **Report**: `REPORT.md`, `FINDINGS-DETAIL.md` and `NEEDS-VALIDATION.md` as Phase 6 describes. It states exactly what
  this run did: profile, scope, commit, the agents and models that ran, the sandbox verdict, and the coverage the
  ledger supports, a `quick` or scoped run as a partial pass. It cites no outcome figures from elsewhere.

## Finish

Your final answer gives the counts of `confirmed`, `needs_validation` and `rejected` records, each confirmed title
with its severity, the coverage gaps, and the path to `REPORT.md`. The audit changes no target source: propose one
fix branch per confirmed finding to @ultimate. Before ending, check that nothing under `<run>` holds a secret value
and that no sandbox run is still going.
