# The Home Repo pattern: prior art, reception and viability

Research of 2026-11-13, branch #260340. Follows `docs/research/matt-pocock-agentic-engineering.md` (#259675), which
covers the pattern from Matt Pocock's own material ([aihero.dev/the-home-repo-pattern](https://www.aihero.dev/the-home-repo-pattern),
2026-11-12). **E** marks evidence (an outcome reported by the people who ran it), **O** marks opinion or claims with no
reported outcome. Sources were read on 2026-11-13.

## 1. Precedents in plain engineering

| Precedent                            | How it fared                                                                                                                                                                                                                                                                                                                            | Kind              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Android `repo` and its manifest repo | A manifest pins a revision for each project; `repo sync -s` syncs to a known-good build; `upload --topic` groups related changes. It has run AOSP for over a decade. [manifest format](https://gerrit.googlesource.com/git-repo/+/HEAD/docs/manifest-format.md), [repo reference](https://source.android.com/docs/setup/reference/repo) | E (owner)         |
| Gerrit atomic cross-repo submit      | Submitting a whole topic exists, but `change.submitWholeTopic` is off by default. [config](https://gerrit-review.googlesource.com/Documentation/config-gerrit.html)                                                                                                                                                                     | docs              |
| Zephyr `west`                        | Rejected both `repo` and submodules. The manifest pins a commit per project and allows a branch name at the cost of bisecting. Its docs say detached HEADs "confuse and even frustrate some users". [why west](https://docs.zephyrproject.org/latest/develop/west/why.html)                                                             | E (owner)         |
| `meta`, `vcstool`                    | Lists of clone URLs with no pinning. `meta` has had no human commit since 2021-06. `vcstool` went stale and was forked as `vcs2l` ([2023-09-21](https://discourse.openrobotics.org/t/vcstool-has-been-stale/33661)).                                                                                                                    | E                 |
| `mani`, `gita`                       | Maintained command runners and status views (2026 releases), with no pinning.                                                                                                                                                                                                                                                           | —                 |
| Git submodules                       | Updates leave a detached HEAD where commits "will quite possibly be lost" ([Pro Git](https://git-scm.com/book/en/v2/Git-Tools-Submodules)).                                                                                                                                                                                             | docs              |
| VS Code multi-root workspace         | A shareable folder list. A 50-repo workspace crashed the extension host ([#318279](https://github.com/microsoft/vscode/issues/318279), 2026-05).                                                                                                                                                                                        | E                 |
| Nx Polygraph, a "synthetic monorepo" | Nx itself says cross-repo changes are "not atomic" and "eventually consistent" ([2026-07-22](https://nx.dev/blog/the-effect-of-monorepos-on-the-effectiveness-of-ai-agents)). Its speed-up comes from a vendor demo.                                                                                                                    | O                 |
| Segment                              | 140+ repos. Shared libraries diverged across them. They merged into one repo ([2018-07-10](https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices)).                                                                                                                                                         | E (self-reported) |
| Block / Cash App                     | About 450 JVM repos with automatic SHA-based dependency bumps. Teams declared "dependency bankruptcy" and fell months to years behind; after the merge into one repo, a cross-cutting change got a green build in 10 minutes ([2026-03-10](https://engineering.block.xyz/blog/from-polyrepo-fragmentation-to-monorepo-leverage)).       | E (self-reported) |
| Google monorepo                      | Unified versioning and atomic changes ([CACM 2016-07](https://cacm.acm.org/research/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)).                                                                                                                                                                              | E (self-reported) |

**Pattern.** Coordinating repos worked at scale only when their pointers were pinned and a tool enforced the sync
(`repo`, `west`). Lists of floating URLs decayed. No polyrepo setup gives atomic cross-repo changes; the closest is a
shared topic merged in dependency order. Matt's pointer lines are floating, prose and unchecked, which puts them at the
weak end of this range. For a personal setup of about 20 repos, that matters much less than for an organisation.

## 2. The same idea for AI agents

**Shared config (all docs, no outcomes).**

- [AGENTS.md](https://agents.md) is the common file; the nearest one in the tree wins.
- [Ruler](https://github.com/intellectronica/ruler) (about 3k★) and [rulesync](https://github.com/dyoshikawa/rulesync) (about 1.6k★) generate each tool's rule files from one source.
- Claude Code [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) are git repos; [managed settings](https://code.claude.com/docs/en/plugins/org) can push them to a whole team.
- Copilot org agents live in the org's `.github-private` repo ([docs](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/prepare-for-custom-agents)).
- Cursor has dashboard Team Rules; Factory has org-wide "delegations".
- Codex reads `~/.codex/AGENTS.md`, then AGENTS.md files from the git root down to the cwd. Amp also reads `/etc/ampcode/AGENTS.md` for organisations.

Matt's claim that "a user folder isn't shareable" is out of date for Claude Code: a marketplace repo is versioned, and
managed settings make it shared.

**Dotfiles for `~/.claude` (O, practitioner blogs).** People `git init` the folder and track `CLAUDE.md`, settings,
skills and agents. They ignore credentials, history, project logs, plugin caches and `settings.local.json`, and they
add gitleaks because a `.gitignore` does not catch a secret pasted into a tracked file
([felipeelias 2026-02-27](https://felipeelias.github.io/2026/02/27/version-your-claude-files.html),
[LaPlante 2026-04-04](https://michaellaplante.com/blog/2026-04-04-version-controlling-your-claude-directory-across-machines/)).
Others share one skills folder across tools with chezmoi symlinks
([2026-03-07](https://dev.to/dotwee/one-skills-brain-for-codex-claude-cursor-and-copilot-with-chezmoi-2p3k)).

**Native cross-repo work.**

| Tool                      | Cross-repo tasks                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor cloud agents       | Yes: up to 300 repos per environment, with a PR in each repo changed ([docs](https://cursor.com/docs/cloud-agent))                                                                                                    |
| Devin                     | Yes: one blueprint per repo, all in one snapshot ([docs](https://docs.devin.ai/onboard-devin/environment/blueprints))                                                                                                 |
| Copilot cloud sandboxes   | Yes; on Actions only the starting repo ([docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent))                                                                                   |
| Claude Code on the web    | Several repos per session                                                                                                                                                                                             |
| Claude Code CLI           | Partly. `--add-dir` grants file access. An added repo's CLAUDE.md loads only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; its AGENTS.md never loads ([memory docs](https://code.claude.com/docs/en/memory)) |
| Codex CLI                 | No. One git root, with `--add-dir` for writes; multi-repo is an open request ([#6219](https://github.com/openai/codex/issues/6219))                                                                                   |
| OpenHands                 | No ([#7752](https://github.com/OpenHands/OpenHands/issues/7752) open)                                                                                                                                                 |
| Amp, Factory, Codex Cloud | Not verified                                                                                                                                                                                                          |

**Company write-ups.**

- **Anyline's agents meta-repo (E, the best field report).** Five engineers, a dozen repos
  ([2026-03-05](http://blog.rubbad.uk/2026/03/05/blog-agents-meta-repo-pattern.html),
  [2026-10-15 update](http://blog.rubbad.uk/2026/10/15/blog-agents-meta-repo-pattern-october-2026-update.html)).
  - Shape: a small always-loaded router, a machine-readable registry (`workspace.yml`, `repos.yaml`), per-domain folders
    that load only when routing picks them, and a workspace root file generated from what is checked out on disk.
  - What they report: a lesson found on a Tuesday "is in every colleague's agent" by Wednesday, and a new hire was
    productive after one clone and one script.
  - Costs: about 64k lines of Markdown, and "the live quarter still rots: prose overviews drift". Their fix was
    verification dates and a drift check that exits non-zero.
  - Two other teams in the company copied it; one stalled after a day.
- **Arinco, Copilot (E, qualitative).** A shared instructions, skills and agents repo across 15+ repos in a multi-root
  workspace ([2026-06-04](https://arinco.com.au/blog/github-copilot-multi-repo-instructions/)).
- **Karpathy's LLM wiki (O).** Raw notes, a wiki and CLAUDE.md as the schema
  ([gist 2026-04-04](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)); no outcomes reported.

## 3. Reception (thin: the name is 1–3 days old)

- **Reach.** The X post had 274k views and 308 replies, but the replies could not be read (X blocks this machine and
  xcancel returns 451). There are no HN or Reddit threads on Matt's version. Matt's own glossary calls "meta-repo" an
  older name for the same thing.
- **Wandering when starting in the hub (O, one first-hand line).** [@BobClowdr, 2026-11-11](https://x.com/BobClowdr/status/2120488255074517383):
  running agents in the home repo, "they regularly think: It would be nice to explore any of the other repos". He finds
  the inverse more reliable: start in each repo, with pointers back to the shared repo.
- **"Lists go stale" (O, practitioner).** [karun.me 2026-03-26](https://karun.me/blog/2026/03/26/structuring-claude-code-for-multi-repo-workspaces/)
  stopped listing repos in CLAUDE.md and points the agent at a `mani` manifest. He also has it check
  `git rev-parse --show-toplevel` before any git operation.
- **Parent-folder workspaces break discovery (E).** [claude-code #36949](https://github.com/anthropics/claude-code/issues/36949):
  with 40+ repos under one parent, CLAUDE.md discovery starts at the wrong root and sessions attach to the wrong folder.
- **Recurring criticisms.** Staleness, raised by every source; prompt bloat; "just use a monorepo" (conceded where
  possible); a wider blast radius for secrets (no incident reported); team adoption.

## 4. Viability

What holds:

- One versioned place for skills and steering beats a copy per repo. This is the only point with field evidence
  (Anyline, Arinco).
- Sharing a clone is the real value. Anyline says so explicitly.
- Monorepo first when you can have one. This is consistent with Block and Segment.

What is weak or untested:

- Hand-written pointer lines. They float, nothing checks them, and every source names staleness as the top failure.
  The fixes others reached are a machine-readable registry or one generated from disk, plus a drift check.
- Starting every session in the hub. There is one report of wandering, and a measured-looking but self-promotional
  result that one session per repo used fewer tokens
  ([dev.to 2026-05-23](https://dev.to/claudeguide/running-claude-code-across-multiple-repos-without-losing-context-2k83)).
- Cross-repo changes. They stay non-atomic and need a landing order.
- His scale numbers (about 20 repos fine, about 400 needs progressive disclosure) are his own estimates; no one has
  measured them.
- Local CLIs open added repos with their instructions only partly loaded (Claude Code, Codex).

Where it breaks:

- **Solo, up to about 20 repos:** fine.
- **A small team (around 5):** works if one person maintains it and a drift check runs (Anyline).
- **Organisation scale:** people move to admin-pushed config (managed settings, `.github-private`, Factory) or to a
  monorepo.
- **Secrets:** a shared repo needs an allowlist ignore plus gitleaks, because ignores miss pasted secrets.

## 5. For Ultimate

Ultimate already works the way @BobClowdr found more reliable:

- Each project is its own root, with its own memory, worktrees and lander.
- `~/.ultimate/` supplies the shared layer to every project.
- `ultimate.projects()` is a registry generated from what is actually registered, and `ultimate.tell` reaches another
  project's @ultimate.

What the plain held step misses, on this host:

- `~/.ultimate/AGENTS.md` loads into every agent's prompt in every project (`docs/settings.md`). A pointer line per
  repo there is exactly the prompt bloat and wandering risk described above.
- `~/.ultimate` holds `secrets.json`, `github-fork-credentials`, `tailscale.json`, lock and SQLite files, and 9.7 GB of
  `projects/` state. `trust.json` and parts of `settings.json` (RAM floor, SearXNG URL) are specific to this machine.
- The skills are absolute symlinks (`/home/ultimate/.ultimate/vendor/...`) into two vendored git clones, which would
  become stray nested repos and break when cloned anywhere else.

**Recommendation: keep the held step, shaped by the prior art.**

1. **Allowlist `.gitignore`.** Start from `*`, then un-ignore only `AGENTS.md`, `skills/`, `agents/`, `extensions/`,
   `settings.json` and `model-families.json`. Add a gitleaks pre-commit hook and keep the remote private.
2. **Vendored clones become pinned pointers, not nested repos.** List `vendor/<name>` with its remote and SHA in a
   small manifest, or as submodules. Make the skill symlinks relative (`../vendor/...`).
3. **Keep `~/.ultimate/AGENTS.md` short.** It holds personal style and machine facts only, with no per-repo list.
   One line covers the rest: other projects are listed by `ultimate.projects()` and reached with `ultimate.tell`;
   cross-project work is one branch per project, landed in dependency order.

**Alternative: a dedicated "home" project.** A git repo registered as an Ultimate project, which `~/.ultimate/skills`
and the other folders link into.

- **Gains:** config changes go through branches, review and the lander, and there is one place to plan cross-project
  features, which is Anyline's shape.
- **Costs:** an install step, a second root to maintain, and still no atomic cross-repo change.
- **When it pays:** once a second person shares the setup or cross-project features become routine.

**Does it change the held step?** Not in direction, only in detail: the allowlist ignore, pinned vendor clones with
relative symlinks, and no repo pointer lines in `~/.ultimate/AGENTS.md`.
