# OpenCode's free models in Ultimate

Assessment of 2026-11-12, branch #265478. OpenCode privately suggested that we assess using its free models in
Ultimate; publicly, it limits them to its own app. **Tabled by the user on 2026-11-12**: nothing was built, and the
questions below were not sent yet. Sources were read on 2026-11-12; OpenCode's docs and client were read at
`sst/opencode` commit `f179e6e5`.

**Verdict.** The Zen free tier cannot be used from Ultimate today without breaking OpenCode's published rules. If
OpenCode confirms in writing and allows Ultimate's own client identity, it is a small change to
`extensions/opencode-go`. Go's own free models already work through Ultimate's Go login.

## The free models and their limits

**Go free models (work in Ultimate today):** `beam-free`, `iceman-contributor-free`, `longcat-2.5-free`. The
[Go docs](https://opencode.ai/docs/console/go) list them as "Unlimited, limited time", and Go is documented for other
clients. Checked on this machine: Ultimate's `opencode-go` OAuth login lists all 32 Go models, and a subagent on
`opencode-go/beam-free` answered.

**Zen free tier (OpenCode's app only).** Pi's `opencode` catalogue (pi-ai 1.5.2) lists `big-pickle`, `beam-free`,
`deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `minimax-m3.1-flash-free`, `mimo-v2.6-flash-free`, `iceman-free`,
`inkling-2-small-free`, `flint-40b-free`, `longcat-2.5-free`, `nemotron-3.5-lightning-free` and
`nemotron-3.5-super-vl-free`. The [model docs](https://opencode.ai/docs/console/models) also list Nemotron 3 Ultra Free
and the classifier `jev-1.13-free`.

- **Limits:** every one is "for a limited time"; LongCat 2.5 Free has "a limit of 100 requests per day". OpenCode's
  client handles a `FreeUsageLimitError` ("Free usage limit reached"); no other limits are published.
- **Data use:** Big Pickle, Iceman, Inkling 2 Small, Flint 40B, MiMo-V2.6-Flash and Nemotron may retain prompts or use
  them for training. GLM-5.3-Flash, DeepSeek V4.1 Flash and MiniMax M3.1 Flash are zero-retention. Inkling 2 Small is
  "not available in the European Union"; Beam Free and LongCat have region limits too.
- **Overlap with Go:** `beam-free` and `longcat-2.5-free` are already in Go. Go has paid versions of the GLM, DeepSeek,
  MiniMax and MiMo flash models within the subscription. What Zen adds is a few free flash and stealth models.

## How OpenCode restricts them

The open-source client (`packages/core`) sends, signed out, `apiKey: "public"` (`plugin/provider/opencode.ts`), and on
every request `x-opencode-client: opencode`, `User-Agent: opencode/<channel>/<version>/<name>`,
`x-opencode-session` and `x-opencode-project` (`session/model-request.ts`). The gate itself runs on OpenCode's server,
whose code is not public. From public issues:

- Since about 2026-09-16 other clients get HTTP 403 `FreeTierError`: "OpenCode's free tier can only be used from
  within OpenCode". It was tightened again on 2026-10-03.
- It looks below the headers: a byte-faithful replay of a genuine request still got 403
  ([#49621](https://github.com/anomalyco/opencode/issues/49621)).
- It looks at the request's shape: turning off OpenCode's own `read` tool or denying shell breaks the free tier even in
  the official app ([#51315](https://github.com/anomalyco/opencode/issues/51315),
  [#50627](https://github.com/anomalyco/opencode/issues/50627)).

Ultimate today identifies as Pi on OpenCode requests: Pi Durable's default identity sends `x-opencode-client: pi` and
`User-Agent: pi/<version> (…)`. Its Go login uses the OpenCode CLI's client id `opencode-cli`.

## Terms and statements

- [Harnesses](https://opencode.ai/docs/console/harnesses): "Free-tier chat models are only available from within
  OpenCode. Other harnesses receive HTTP `403` for those models, even with a Console API key. Use paid models or a Go
  subscription." The [Pi page](https://opencode.ai/docs/console/harnesses/pi): free-tier models "return HTTP `403` from
  Pi".
- [Inference API](https://opencode.ai/docs/console/api/inference): "Free-tier chat models are only available from
  within OpenCode; other clients receive HTTP `403`, even with an API key."
- [Go](https://opencode.ai/docs/console/go): clients should "Identify itself with its own user agent, such as
  `my-coding-agent/1.0`, rather than a generic SDK or HTTP-library name." Pi is listed among "Validated clients".
- [Terms of Service](https://opencode.ai/legal/terms-of-service) (effective 2026-11-08) list, as "grounds for
  termination", use that "decompiles, reverse engineers, or otherwise attempts to obtain the source code or underlying
  ideas or information of or relating to the Services", that "creates, maintains, or uses accounts in bulk, or creates,
  maintains, or uses multiple accounts to circumvent usage limits, access restrictions, … promotions", or that is
  "deceptive".
- An OpenCode collaborator on 2026-09-18 ([#49621](https://github.com/anomalyco/opencode/issues/49621), also
  [#49590](https://github.com/anomalyco/opencode/issues/49590)): "We've been tightening our logic to fight abuse You
  cannot use the free tier in other harnesses (this is only a limitation for the free tier nothing else)."

No public statement allows other clients onto the free tier; OpenCode's private suggestion is the only basis.

## Options

| Option                                                | What it is                                                                                                                                                                                     | Terms risk                                                                                                                                                          | Complexity, code delta                                                                                                                                                                                                          | Written confirmation needed                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **(b) Ultimate's own identity, allowed by OpenCode**  | `extensions/opencode-go` also registers Pi's `opencode` (Zen) provider with the same device login; OpenCode requests carry `User-Agent: ultimate/<version>` and `x-opencode-client: ultimate`. | None once confirmed; OpenCode sees and controls it by identity.                                                                                                     | Small: about 60–80 lines in `extensions/opencode-go` (provider registration, header wrapper, README), no core change. Reuses Pi's provider, catalogue and session header, and the Go login.                                     | Ultimate's identity is allowed on the free tier; its limits; ideally an OAuth client id of its own.     |
| **(a) The real `opencode` CLI as a delegated worker** | A tool runs `opencode run --format json -m opencode/<free>` in a worktree; OpenCode's own agent and tools do the task.                                                                         | Medium: the requests really come from OpenCode, but Ultimate orchestrates them, and nothing says that counts as "within OpenCode".                                  | Medium: a new extension of about 300–500 lines with a card and an e2e test against a fake CLI. Free models serve only delegated tasks, not Ultimate's own conversations.                                                        | Driving the official CLI headlessly counts as "within OpenCode".                                        |
| **(a′) `opencode serve` as a model backend**          | Like `extensions/claude-code` drives Claude Code.                                                                                                                                              | Medium.                                                                                                                                                             | Large: `pi-claude-code` alone is about 3,000 lines. `opencode serve`'s `/generate` takes a prompt only (no messages, tools or streaming), and injecting Ultimate's tools would likely trip the request-shape check. Not viable. | As (a).                                                                                                 |
| **(c) Imitating the OpenCode client**                 | Copying OpenCode's headers and whatever its official build adds.                                                                                                                               | High: circumventing a publicly stated access restriction; since header replays fail, it needs reverse engineering the binary, which the terms forbid. An arms race. | Small code, endless upkeep.                                                                                                                                                                                                     | Ruled out even with permission: OpenCode could not see or control it. Not even as a personal extension. |

**Recommended:** ask OpenCode the questions below in writing; build (b) in the repo only after its written answer,
citing it in `extensions/opencode-go/README.md`. Until then keep Ultimate identifying as `pi` on Go requests.

**Easier alternative:** build nothing; use Go's three free models and its cheap flash models through the existing Go
login. Optionally hide Zen's `*-free` models from the `opencode` picker, where they can only fail with 403.

**Repo or personal:** (b) belongs in the repo once confirmed. (a) before a confirmation could only be a personal
extension, like the machine-local Antigravity adapter. (c) belongs in neither.

**Risks the user would see:** free models are "limited time" and can vanish or start answering 403 without notice;
several retain or train on prompts, which matters when Ultimate sends code.

## Questions for OpenCode

1. May Ultimate, an open-source coding agent (github.com/HazAT/ultimate), call the Zen free-tier chat models from its
   own client? If so, will you allow requests that send `User-Agent: ultimate/<version>`, `x-opencode-client: ultimate`
   and a stable `x-opencode-session` per conversation?
2. Does that need a signed-in Console account (device login or API key), or is anonymous `public` access fine too?
   Which limits apply (per account, per IP, per day), and which error signals one?
3. Ultimate's Go sign-in uses your CLI's client id `opencode-cli`. May we register our own OAuth client id for the
   Console device flow, and how?
4. Which free models are in scope, and how should we track additions and retirements (models.dev or
   `/inference/v1/models`)?
5. May the free models be on by default for every Ultimate user, or only opt-in? Must we show each model's
   data-training and region notice?
6. If not through our own client: is driving the official `opencode` CLI or server headlessly from Ultimate, as a
   delegated worker, "within OpenCode" for the free tier?
7. For Go, we currently identify as `pi`. Is switching to `ultimate` fine, and would you list Ultimate among your
   validated clients?
8. Can you confirm this from an @anoma.ly address or in your docs, so our README can cite it? How will you announce
   changes or a revocation?
