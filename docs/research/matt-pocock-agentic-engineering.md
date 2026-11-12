# Matt Pocock: the Home Repo pattern, his published tools, and what Ultimate can take from them

Research of 2026-11-12, branch #259675. Sources are linked inline and listed at the end. The video's transcript could
not be read: YouTube answers this machine with "Sign in to confirm you're not a bot" (`yt-dlp` 2026.10.26, web, mweb,
tv and embedded clients, and the innertube `get_transcript` call all refused). The pattern is taken from the article
the video links as its full write-up, the chapter list in its description, and his two X posts about it.

## 1. The Home Repo pattern

**Sources.** Video [The Home Repo Pattern: Run agents across ALL your repos](https://www.youtube.com/watch?v=hWe-j78vNpc)
(2026-11-12, a live recording) and a short cut [The Home Repo Pattern](https://youtu.be/zyQxyNQZ8B4) (same day).
Chapters: "A too-simple technique goes viral", "The multi-repo agent problem", "The home repo solution", "Tour of my
home repo", "Scaling and why not monorepos", "Personal wiki and custom tooling". Full write-up:
[aihero.dev/the-home-repo-pattern](https://www.aihero.dev/the-home-repo-pattern) (updated 2026-11-12). First post:
[X, 2026-11-10](https://x.com/mattpocockuk/status/2120260969750540327).

**Definition** ([AI Coding Dictionary](https://www.aihero.dev/ai-coding-dictionary/home-repo)): "A repository that holds
your skills, your AGENTS.md and your shared docs, and points at your other repos. You run your agent in the Home Repo,
and it opens or clones the other repos as the task needs them."

**The problem.** "When a project spans several repos, an agent started in one of them sees only that repo. Each repo
ends up with its own copy of the skills and the agent setup, and planning a feature that crosses repos means working
without the whole overview."

**What it gives** (his three points, in both the post and the article):

1. "Put all your steering files and tooling in one place"
2. "Have a single spot to run all your agents in"
3. "Make sweeping changes over multiple repos"

**What lives where.**

| In the Home Repo                                                                                                    | Stays in each repo                                 |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Skills used across repos (one copy, the newest)                                                                     | Its own AGENTS.md                                  |
| AGENTS.md with an "Other Repos" pointer section                                                                     | Its build and test commands                        |
| Steering files and shared docs: coding standards ("the first doc worth sharing"), a glossary, system-wide decisions | Repo-specific docs, history, remote, issue tracker |
| A small Markdown wiki                                                                                               | The code itself                                    |
| Tooling, e.g. a CLI connecting the agent to external services, with its env vars                                    |                                                    |

**How agents reach the other repos.** Plain pointers in AGENTS.md, one line per repo:

```
Storefront (Next.js app): ~/repos/acme/storefront. Clone from git@github.com:acme/storefront.git if missing.
Payments API: ~/repos/acme/payments-api. Read its AGENTS.md before changing it.
AI Hero: ~/repos/ai/ai-hero (git pull to view latest, likely out of date)
```

The agent works in the clone at that path, or clones it there if missing. "Each repo is cloned once. Each feature gets a
worktree inside that clone, so several agents can work in one repo at the same time." Issues: "The agent can reach
every repo's issue tracker… Letting it file each issue where it fits works fine." Sessions start in the Home Repo,
"also the place to grill a feature that crosses repos".

**Sharing.** Skills are versioned with git in the Home Repo, not kept in `~/.claude/skills`: "A user folder is the
stopgap… A Home Repo is a project: its skills are versioned with git, and a team can share it." For a team, "the Home
Repo is the thing you share, and everyone runs their agents in it." Memory is the wiki in the repo; tasks stay in each
repo's tracker. No tool, CLI or submodules are needed: "Pointers in AGENTS.md and the tools you already have are enough
to start."

**Scale.** About 20 repos is fine; at about 400, use progressive disclosure: one pointer per business area to a file
listing its repos. At thousands, a skills marketplace. Submodules work at 5–10 repos but pointers do the same. A
monorepo is better when you can have one; the Home Repo is for when you can't (public and private repos mixed, a team
that won't adopt one). In CI, the Home Repo goes into the sandbox of a software factory and clones what it needs.

**Setup prompt.** The article ships a four-step prompt: inventory every git repo (path, remote, visibility, last
commit) → inventory shared material and sort each item into shared / duplicate / repo-specific / installed → agree a
table of moves plus the new AGENTS.md → apply, removing moved copies from each repo on a local branch, "pushing is my
call". It grills in numbered rounds with a recommended answer each, worded "so 'yes' accepts it", and only reads until
the plan is approved.

## 2. What he has published

### Repos ([github.com/mattpocock](https://github.com/mattpocock), GitHub API, read 2026-11-12)

| Repo                                                                                                                                 | Latest                              | What it is                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [skills](https://github.com/mattpocock/skills)                                                                                       | v1.3.2, 2026-10-29; main 2026-11-12 | His skills ("Skills For Real Engineers"); installs as a Claude Code, Codex or Copilot plugin or via skills.sh. Vendored here.                                                                                                                                                      |
| [sandcastle](https://github.com/mattpocock/sandcastle)                                                                               | v0.14.0, 2026-11-02                 | TypeScript `sandcastle.run()`: agents in sandboxes (Bubblewrap, Seatbelt, Docker/Podman, Daytona, E2B, Fly, Modal, Vercel) on worktrees/branches. A v1 "harness + sandbox + `Agent()` per skill" is [pitched](https://x.com/mattpocockuk/status/2116805878187794740), not shipped. |
| [dictionary-of-ai-coding](https://github.com/mattpocock/dictionary-of-ai-coding)                                                     | 2026-11-12                          | Source of the [AI Coding Dictionary](https://www.aihero.dev/ai-coding-dictionary), 72 entries.                                                                                                                                                                                     |
| [agent-rules-books](https://github.com/mattpocock/agent-rules-books)                                                                 | 2026-05-13                          | AGENTS.md rules distilled from Clean Code, DDD, DDIA and others, in three sizes.                                                                                                                                                                                                   |
| [evalite](https://github.com/mattpocock/evalite)                                                                                     | 2026-11-09                          | TS eval runner, deprecated in favour of Langfuse.                                                                                                                                                                                                                                  |
| [course-video-manager](https://github.com/mattpocock/course-video-manager), [ai-hero-cli](https://github.com/mattpocock/ai-hero-cli) | 2026-11-12                          | His own tooling and the AI Hero exercise runner.                                                                                                                                                                                                                                   |

`mattpocock/software-factory` is mentioned on X but returns 404 (private).

### AI Hero ([aihero.dev](https://www.aihero.dev))

| Item                                                                                                                                                                 | Date                   | What it is                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Software Factories for Real Engineers](https://www.aihero.dev/cohorts/software-factories-for-real-engineers-xdy1m)                                                  | cohort from 2026-11-09 | Two-week cohort; the Home Repo was taught there first.                                                                                                                                                                                                                                                                                                                                               |
| [AI Coding for Real Engineers](https://www.aihero.dev/cohorts/ai-coding-for-real-engineers-m0k0w)                                                                    | 2026-05-08             | Earlier cohort; [96-min workshop version](https://www.youtube.com/watch?v=-QFHIoCo-Ko) (2026-04-24).                                                                                                                                                                                                                                                                                                 |
| [AI Coding Crash Course](https://www.aihero.dev/workshops/ai-coding-crash-course), [AI SDK v6 Crash Course](https://www.aihero.dev/workshops/ai-sdk-v6-crash-course) | 2026-06-24, 2026-11-06 | Self-paced workshops.                                                                                                                                                                                                                                                                                                                                                                                |
| [AI Coding Dictionary](https://www.aihero.dev/ai-coding-dictionary)                                                                                                  | 2026-11-12             | Vocabulary: model, sessions, tools, failure modes, handoffs, memory and steering, patterns of work.                                                                                                                                                                                                                                                                                                  |
| [Skills catalogue](https://www.aihero.dev/skills) and [newsletter](https://www.aihero.dev/skills/subscribe)                                                          | from 2026-05-05        | One page per skill, changelogs v1 (06-18), [v1.1](https://www.aihero.dev/skills/skills-changelog-v1-1-wayfinder-to-spec-to-tickets-grilling-improvements) (07-08), [v1.2](https://www.aihero.dev/skills/skills-changelog-v12-wait-what-writing-for-agents-claude-code-plugin-and-more) (08-05), [v1.3](https://www.aihero.dev/skills-changelog-v13-implement-spec-pr-retro-and-glossary-md) (10-05). |

Articles (2026): [Getting Started With Ralph](https://www.aihero.dev/getting-started-with-ralph) and
[11 Tips For Ralph](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum) (01-08),
[Essential Feedback Loops For TS](https://www.aihero.dev/essential-ai-coding-feedback-loops-for-type-script-projects)
(01-16), [Complete Guide To AGENTS.md](https://www.aihero.dev/a-complete-guide-to-agents-md) (01-18),
[Tracer Bullets](https://www.aihero.dev/tracer-bullets) and
[Why the Anthropic Ralph plugin sucks](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks) (01-22),
[Dangerous git commands hook](https://www.aihero.dev/this-hook-stops-claude-code-running-dangerous-git-commands) (02-10),
[Never Run Claude /init](https://www.aihero.dev/never-run-claude-init) (02-24),
[How To Make Codebases AI Agents Love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love) (02-26),
[My 7 Phases Of AI Development](https://www.aihero.dev/my-7-phases-of-ai-development) (03-16),
[9 Things People Get Wrong With /grill-me](https://www.aihero.dev/things-people-get-wrong-with-grill-me-and-grill-with-docs)
(05-25), [Kill the bloat in Claude Code's system prompt](https://www.aihero.dev/how-to-kill-the-bloat-in-claude-codes-system-prompt)
(07-07), [The Home Repo Pattern](https://www.aihero.dev/the-home-repo-pattern) (11-12).

### Videos ([channel feed](https://www.youtube.com/feeds/videos.xml?channel_id=UCswG6FSbgZjbWtdf_hMLaow), latest 15)

2026-11-12 The Home Repo Pattern (two uploads) · 11-11 [LIVE: Writing code that doesn't suck with the creators of
Pi](https://youtu.be/ZBTegd8DUZM) · 11-06 Someone wrote a PAPER about my skill · 11-05 Is vibe coding an insult? · 11-04
Junior engineers: don't wait for permission · 10-16 When should you NOT use /grill-me?; Your agent is a tactical
tornado; The secret to building robust frontend apps with agents · 10-15 WHY ARE YOU TYPING; Give your agent a goal,
and let it be creative · 10-14 Mutation testing is AWESOME · 10-13 Tell your agents to CARE about the codebase; /retro
is a banger of a skill; STOP running your checks in harness hooks. Older: "I Open-Sourced My Own AFK Software Factory"
(2026-04-29), [Software Fundamentals Matter More Than Ever](https://www.youtube.com/watch?v=v4F1gFy-hqg) (AI Engineer,
2026-04-23), [LIVE: The /wayfinder Demo](https://www.youtube.com/watch?v=251hsWgoTPM) (2026-07-13),
[Fixing the PR Bottleneck](https://www.youtube.com/watch?v=LlgiOCmFG_w) (AI Engineer Paris, 2026-09-25).

### Talks, podcasts, threads

[The Pragmatic Engineer: AI Skills with Matt Pocock](https://newsletter.pragmaticengineer.com/p/ai-skills-with-matt-pocock)
(2026-09-17) · [Latent Space: /wayfinder](https://latent.space/p/wayfinder-skill/) (2026-08-20) ·
[Unhandled Exception #88](https://unhandledexceptionpodcast.com/posts/0088-mattpocock/) (2026-07-31) · X:
[100% AI-contributed, 9 lessons](https://x.com/mattpocockuk/status/2024049581529460839) (02-18),
[Sandcastle](https://x.com/mattpocockuk/status/2039343457282531549) (04-01),
[AFK agents are not a myth](https://x.com/mattpocockuk/status/2048159313357598989) (04-25),
[Use MORE abstractions](https://x.com/mattpocockuk/status/2106425743479546343) (10-03).

### The vendored skills against upstream

`~/.ultimate/vendor/mattpocock-skills` is at `4ae2317` (2026-10-31), fetched 2026-11-11. Upstream `main` is two commits
ahead (`d18183f`, merge `5863806`): a one-word change in `in-progress/software-factory` ("job" is the CI vendor's word;
explore leaves findings). Nothing in a linked skill changed.

What the vendor has that `~/.ultimate/skills` does not link:

| Skill                                                                        | What it is                                                                                                                                                                                                        | Fit here                                                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `in-progress/chief-of-staff`                                                 | A long-running session as "Directly Responsible Individual" for a goal: all work in fresh subagents, memory in a dated wiki, retro on one in five subagent sessions, "pit of success" and "no workarounds" rules. | Mostly what @ultimate, memory, dreams and hands-off goals already are. Its wiki rules are worth taking (lesson 9). |
| `in-progress/software-factory`                                               | A glossary for designing a factory: task, trigger, run, runner, ticket tracker, orchestrator; three brakes; "start slow".                                                                                         | Useful vocabulary if the user wants triggered work; user-invoked only.                                             |
| `in-progress/loop-me`                                                        | Grills the user into workflow specs (trigger, checkpoint, "push right", brief).                                                                                                                                   | Close to automations; optional.                                                                                    |
| `in-progress/claude-handoff`, `setup-ts-deep-modules`, `writing-*`, `misc/*` | Claude Code specific, TS setup, prose writing, frozen misc.                                                                                                                                                       | No.                                                                                                                |

**A real gap in the linked ones.** Ten linked skills tell the agent to "Call the Skill tool with X" (`tdd`, `retro`,
`implement`, `implement-spec`, `improve-codebase-architecture`, `triage`, `wayfinder`, `grill-with-docs`, `grill-me`,
`handoff`). Ultimate has no Skill tool; skills are read with `read`. The dream of chapter evidence-first (#248956)
replaced only the two thin aliases with local copies (`~/.ultimate/skills/grill-me`, `grill-with-docs`). Upstream
treats such differences as the harness's job (`.out-of-scope/harness-name-collisions.md`: "report that to the
harness"), so the fix belongs in Ultimate's skill prompt, not in more local copies.

## 3. Lessons, and where Ultimate stands

"Already" cites where Ultimate does it; "Partial" and "New" are the candidates.

| #   | Lesson                                                                                                                                                            | Source                                                                                                                                                         | Ultimate                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Align before building.** Agents "fill gaps silently"; grill one decision at a time, a recommended answer each, worded so "yes" accepts it.                      | [Grilling](https://www.aihero.dev/ai-coding-dictionary/grilling), `skills/productivity/grilling`                                                               | Already: assessment first and numbered `Decisions:` with picks (`agents/coordinator.md`), question cards; `grilling` linked.                                                                |
| 2   | **Spec is the destination, tickets the journey**: tracer-bullet tickets with blocking edges, worked as a frontier in parallel.                                    | [v1.3 changelog](https://www.aihero.dev/skills-changelog-v13-implement-spec-pr-retro-and-glossary-md), [Tracer Bullets](https://www.aihero.dev/tracer-bullets) | Already: the `plan` ledger (epics, tasks with `deps`), one worker per task. Vertical slices are not stated as a rule (Partial).                                                             |
| 3   | **Fresh context per unit of work**; communicate by context pointers, not pasted content.                                                                          | `chief-of-staff`, upstream commit "Start subagents with a fresh context window, not a fork"                                                                    | Already: subagents start fresh, `fork` is opt-in (`docs/subagents.md`); briefs point at files and conversations.                                                                            |
| 4   | **Stay in the smart zone**: clear or hand off rather than push through a full context; Ralph loops restart instead of compacting.                                 | Dictionary "Smart zone", [Ralph plugin critique](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks)                                                  | Partial: branches are short-lived; roots compact, and dreams start a fresh chapter (`extensions/dream/README.md`).                                                                          |
| 5   | **The codebase beats the prompt**: deep modules, strong types, lint and more abstractions shrink the agent's design space.                                        | [Codebases AI Agents Love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love), [X 10-03](https://x.com/mattpocockuk/status/2106425743479546343)      | Already: `pnpm check` import boundaries (`lint/ultimate.ts`), the core tier, explicit state machines (AGENTS.md Conventions), `codebase-design` linked.                                     |
| 6   | **A check can fail, a sentence cannot**: mechanical rules become checks; delete no-op instructions; AGENTS.md shrinks over time.                                  | `skills/engineering/retro`, [AGENTS.md guide](https://www.aihero.dev/a-complete-guide-to-agents-md)                                                            | Already: AGENTS.md "Review quality" (propose a check, lint enforces approved rules); the dream's codify pass.                                                                               |
| 7   | **Standards belong to the reviewer**, who has the least context pressure; AGENTS.md is for navigation pointers, `CODING_STANDARDS.md` is read during review.      | `skills/engineering/retro` ("Implementation vs Review")                                                                                                        | Partial: reviewer definitions exist (`.ultimate/agents/reviewer-*.md`), but the judgment-call conventions sit in `AGENTS.md` (141 lines), loaded into every worker.                         |
| 8   | **Retro by hand, not automated**: "an automated retro finds false positives, keeps fixing them."                                                                  | [v1.3 changelog](https://www.aihero.dev/skills-changelog-v13-implement-spec-pr-retro-and-glossary-md)                                                          | Different, deliberately: dreams run automatically (A6, A7) but every proposal goes through a decision card (`extensions/dream/DREAM.md`), so a human gates the fixes.                       |
| 9   | **Memory as history, not the present**: date every claim, cite the commit it was true at, supersede rather than rewrite; look for a shared wiki first.            | `skills/in-progress/chief-of-staff`                                                                                                                            | Partial: memories carry an updated date and a source and get fact-checked by memory reviews (`extensions/lineage/README.md` "Project memory"); they don't pin the commit they were true at. |
| 10  | **Shared steering lives in one place**, versioned and shareable.                                                                                                  | [Home Repo](https://www.aihero.dev/the-home-repo-pattern)                                                                                                      | Partial: the user layer `~/.ultimate/` applies to every project (`docs/settings.md`), but it is not in git and has no `AGENTS.md`; see section 4.                                           |
| 11  | **Three brakes before acceleration**: automated checks, automated review, human review; add one trigger at a time, cap loops at a few tries.                      | `skills/in-progress/software-factory`                                                                                                                          | Already: the lander's checks and CI, the review team, preview approval; the watchdog retries once.                                                                                          |
| 12  | **Day shift plans and reviews, night shift implements AFK**; AFK fails on a bad plan, unknown unknowns, or feedback loops that can't tell good from bad.          | [X 04-25](https://x.com/mattpocockuk/status/2048159313357598989), Dictionary "AFK"                                                                             | Already: hands-off goals (`extensions/goal/README.md`), automations, background branches. No sandbox: agents run on the host in worktrees (out of scope here).                              |
| 13  | **Human review is the bottleneck**: "Writing code got cheap. Reading it did not." His `/pr` adds a "Merge Danger" section: one-way or two-way door, blast radius. | `skills/engineering/pr`                                                                                                                                        | New: landing cards and `workspace submit` carry the divergence, not the danger.                                                                                                             |
| 14  | **Progressive disclosure**: a small always-loaded layer of one-line pointers.                                                                                     | Dictionary "Progressive disclosure"                                                                                                                            | Already: AGENTS.md "Developer reference — read when needed", skill descriptions in the prompt.                                                                                              |
| 15  | **Measure tool and prompt bloat** before blaming the model.                                                                                                       | [Kill the bloat](https://www.aihero.dev/how-to-kill-the-bloat-in-claude-codes-system-prompt)                                                                   | Already available: the `wire` extension (off, memory `wire-stays-off`) and the context tab.                                                                                                 |
| 16  | **Change a skill only on an observed failure**; reject hypothetical improvements.                                                                                 | [SCOPE.md](https://github.com/mattpocock/skills/blob/main/SCOPE.md)                                                                                            | Already, for tests ("one regression test per bug that actually happened", AGENTS.md); dream proposals need evidence.                                                                        |

## 4. The Home Repo in Ultimate's terms

| Home Repo piece                | Ultimate today                                                                                                                                                             | Status                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Shared skills, agents, tooling | `~/.ultimate/{skills,agents,extensions}` load in every project, between the clone and the project (`docs/settings.md`)                                                     | Covered, but not versioned: `git -C ~/.ultimate` → "not a git repository" |
| Shared AGENTS.md               | `~/.ultimate/AGENTS.md` loads ahead of each project's (`docs/settings.md`)                                                                                                 | Supported, unused: the file does not exist                                |
| Pointers to the other repos    | `ultimate.projects()` lists every project, path and URL; Projects switcher                                                                                                 | Covered, better than prose pointers (live, with status)                   |
| Shared memory / wiki           | Memory per project root, in that project's `state.sqlite` (`extensions/lineage/README.md`)                                                                                 | Gap: user- and machine-wide facts are kept twice (below)                  |
| One place to run agents        | "A hub project whose @ultimate checks the other projects and starts work in them" (`README.md`, "One Ultimate or many"); `ultimate.tell`, cross-project `entries`/`search` | Covered as a mechanism; no hub project is set up                          |
| Sweeping changes across repos  | A branch belongs to one project's worktree and lander; another project is reached by `tell`ing its @ultimate                                                               | Partial: fan-out works, but nothing tracks one change across projects     |
| Tasks in each repo's tracker   | Each project's plan ledger and to-dos (`extensions/todos/README.md` "Other projects")                                                                                      | Covered                                                                   |

The duplication is real today. The other project on this host (a private app) keeps its own copies of user and machine facts that this
project also keeps: its memory has "Heavy runs may overlap while at least 3 GB remains available…", "The VPS has 6
cores shared with Ultimate…" and "User wants specifics settled before building…", next to this project's
`ram-floor-3gb`, `vps-memory-tmpfs` and `user-profile`; its `AGENTS.md` repeats a paragraph on the 3 GB RAM floor that
Ultimate's machine queue already enforces. Its lesson "Never pkill by pattern on this machine" applies to every project
but lives only there.

Ultimate is already stronger than the pattern where isolation matters: Matt's agent walks into the other repos'
clones, while each Ultimate project keeps its own worktrees, checks and lander. What the pattern adds is a versioned,
shared home for the user layer, and memory that is not bound to one project.

## Sources

Read 2026-11-12: [The Home Repo Pattern article](https://www.aihero.dev/the-home-repo-pattern); the video's page
description (chapters); X posts [2120260969750540327](https://x.com/mattpocockuk/status/2120260969750540327),
[2120838662254420341](https://x.com/mattpocockuk/status/2120838662254420341) and
[2120847219788308872](https://x.com/mattpocockuk/status/2120847219788308872) via api.fxtwitter.com;
[github.com/mattpocock/skills](https://github.com/mattpocock/skills) at `5863806` (SKILL.md files, SCOPE.md,
GLOSSARY.md, `.out-of-scope/`); the GitHub API repo list; the [aihero.dev RSS](https://www.aihero.dev/rss.xml); the
YouTube channel feed; the articles, podcasts and threads linked above. The research subagent's reading is in #259790.
