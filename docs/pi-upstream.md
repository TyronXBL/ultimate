## Borrowed from Pi

- `server/http.ts` — adapted HTTP dispatcher, not exported; prevents early provider stream termination. undici in package.json exists only for this file. Drop when Pi exports configureHttpDispatcher and applyHttpProxySettings; keep the MIT notice until then.
- `pnpm-workspace.yaml` — registers patches/@earendil-works__chord@1.5.2.patch, keeping numeric SGR colours that 1.5.2's sanitizeOutput strips with the other escape sequences, patches/@earendil-works__pi-durable@1.5.2.patch, adding transactional input-placement hooks, marking entries placed from input submissions (input: true) so extensions can distinguish requests from user-role writes, and adding Harness.hold()/release(), which keep the scheduler from starting task runs whatever resume() says (a held invocation parks as pending at its next phase boundary; abort handlers still run), and letting a compaction summary use the model's output limit instead of 0.8 × reserveTokens, as pi-coding-agent has since pi #9512 (`test/compaction-summary.test.ts`), and letting a `beforeCompact` hook fail the compaction with its own message (`{ fail }`, `test/lineage-compaction.test.ts`), and patches/@earendil-works__pi-claude-code@0.1.0.patch, rebuilding replay cache markers to stay within Claude's four-block limit and wording an incomplete response without stderr ("stream ended without …") so pi-ai's isRetryableAssistantError retries it, accepting the bare-string first user message Claude Code sends when replaying a history that starts with "/", naming the relay's underlying error (class and message) in its failure, and resolving a tool_use named without its MCP prefix (a bare bash for mcp__pi__bash) to Pi's tool instead of ending the turn, leaving a name Pi does not have to its "Tool … is not available" tool result so the model recovers, and parsing a streaming tool call's partial arguments with pi-ai's parseStreamingJson, as pi-ai's own providers do, so tool cards show an edit or write arriving, and defining every later tool by value in a tool_addition block (the inline-tools-2026-09-15 beta, as pi-ai 1.4.0's Anthropic transport does) instead of falling back to one merged system prompt once a tool was redefined: that fallback put every section or tool change at the start of the cached prefix, so each landing rewrote @ultimate's whole cache (17 rewrites, 5.8M tokens in one day), and normalising tool ids from other providers (an OpenAI call_…|fc_… id) to Anthropic's ^[a-zA-Z0-9_-]{1,64}$ with a hash suffix in both tool_use and tool_result frames, since a conversation switched from openai-codex otherwise fails every turn with a 400, and treating a claude auth status that gives no parseable answer (a timeout, a crash, unreadable output) as unknown rather than logged out: the auth check then keeps its last definite answer for that environment instead of hiding every Claude Code model, which once switched @ultimate onto a paid API key while Claude Code was logged in. The pi-claude-code patch also gives a discovered model missing from Pi's built-in list the context window and max output of its family's newest built-in model (Fable 5.2: 1M / 128k, not the 200k / 64k guess), and listens for errors on model discovery's input, so a probe that exits before taking it fails discovery by its exit code instead of crashing the host with an unheard EPIPE. It also adds useExchangeTap(), which keeps each turn's relayed HTTP exchange (credentials redacted) and hands it to Ultimate after the turn, for Wire. The pi-durable patch also gives NodeExecutionEnv a spawn option and the pi-claude-code patch adds useSpawn(), so bash and Claude Code start their processes from `lib/spawn.ts`'s small helper process instead of forking the large host. The pi-claude-code patch also makes the replay rewrite count the user messages Claude Code puts first instead of assuming one, so the initial system messages go after the whole leading run: Claude Code 2.1.319 and newer put a "Called the Read tool" user message in front for a prompt that mentions an existing path with "@", and the second request of such a conversation was refused with a 400 (#566809). It also runs turns with CLAUDE_CODE_DISABLE_FILE_MENTIONS=1, so an agent's "@name" in a prompt no longer pulls the content of a file or the listing of a folder with that name into the request; Claude Code adds a one-line note naming the mentions instead (upstream sets it since 799943e). The Claude Code patches change only the transcript Pi sends through Claude Code and how its process starts; Claude Code itself is unmodified. Drop each patch when upstream ships the corresponding fix; pnpm errors when a versioned patch no longer matches.
- `extensions/claude-code/test/claude-code-cache.test.ts` — internal imports exercise the pi-claude-code replay cache patch registered in pnpm-workspace.yaml. Drop this coupling and the patch when upstream rebuilds cache breakpoints within Claude's four-block limit.
- `extensions/claude-code/test/claude-code-inline-tools.test.ts` — imports pi-claude-code's patched prepareNativeTranscript. Drop with the patch when upstream defines redefined tools inline.
- `extensions/claude-code/test/claude-code-incomplete.test.ts` — imports pi-claude-code's patched incompleteResponseError and normalizeError and pi-ai's isRetryableAssistantError and isContextOverflow, and drives streamClaudeCode through the patched useSpawn() with a child that refuses the turn itself. Drop with the patch when upstream makes an incomplete response without a reason retryable and reports Claude Code's own error as the reason.
- `extensions/claude-code/test/claude-code-native-tool.test.ts` — imports pi-claude-code's patched piToolName and its TurnRelay. Drop with the patch when upstream accepts a tool_use named without its MCP prefix.
- `extensions/claude-code/test/claude-code-tool-ids.test.ts` — imports pi-claude-code's patched prepareFrames. Drop with the patch when upstream normalises other providers' tool ids.
- `extensions/claude-code/test/claude-code-slash-replay.test.ts` — imports pi-claude-code's patched rewriteInitialRequest and TurnRelay. Drop with the patch when upstream accepts a string first user message on replay and reports the relay error's message.
- `extensions/claude-code/test/claude-code-leading-users.test.ts` — drives pi-claude-code's runClaudeRequest through the patched useSpawn() with a request that starts with two user messages, as Claude Code 2.1.319 and newer send for a prompt that mentions an existing path with "@" (#566809), and checks that turns start with CLAUDE_CODE_DISABLE_FILE_MENTIONS=1. Drop with the patch when upstream places system messages after every leading user message and the pin reaches 799943e.
- `extensions/claude-code/test/claude-code-discovery.test.ts` — drives pi-claude-code's discoverClaudeModels through the patched useSpawn() with a child that exits before its output ends, and checks that discovery starts Claude Code without CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and DISABLE_TELEMETRY, with which it answers from its built-in model list instead of the account's (#542940). It also imports the patched modelFromDiscovery, which gives a model newer than Pi's built-in list (Fable 5.2) its family's limits instead of 200k / 64k (#544597). Drop each part with its patch when upstream settles childExit() for a child that already exited, discovers without those switches, or knows the new model's limits.
- `extensions/claude-code/test/claude-code-turn-relay.test.ts` — drives pi-claude-code's patched TurnRelay, which retries a request whose connection fails in transport before any response byte (PR #113, anthropics/claude-code#106197). Drop with the patch when upstream retries these failures.
- `test/process-group.test.ts` — calls pi-claude-code's patched killProcessTree, which signals a process group only for an integer pid above 1 (#562356). Drop with the patch when upstream checks the pid before a group kill.
- `extensions/wire/test/wire.test.ts` — drives pi-claude-code's patched TurnRelay, which keeps each turn's exchange for useExchangeTap. Drop with the patch when upstream exposes the relay's exchanges.
- `lib/compaction.ts` — inlines Pi's unexported createCompaction so a caller's checks and manual compaction creation share one transaction (lineage's tally compaction). Drop when Pi exposes atomic compaction admission.
- `extensions/claude-code/server.ts` — calls the patched useSpawn() of pi-claude-code's claude-cli.ts so Claude Code starts from the process helper. Drop with the patch when upstream accepts a spawn function. It also calls the patched useExchangeTap(), which hands each relayed request (headers with credentials redacted, the exact body) and its raw response to Wire (`extensions/wire`). Drop that part when upstream exposes the relay's exchanges.
- `extensions/lineage/rewind.ts` — copies pi-durable's unexported normalizeToolPath (unicode spaces, a leading @) so going back resolves edit and write paths exactly as those tools do, then resolves them with the exported NodeExecutionEnv.absolutePath (home directory and file URLs). Drop when Pi exports resolveToolPath's normalization.
- `extensions/lineage/server.ts` — returns the patched `beforeCompact` `{ fail }` decision when no summary model answers, so the failure names each model tried instead of Pi summarizing once more on the limited one. Drop the patch when Pi lets a hook fail a compaction.
- `extensions/lineage/catchup.ts` — uses the patched transactional beforeInput hook to place catch-up notes before inputs. Drop the patch when Pi ships input-placement hooks.
- `extensions/messages/server.ts` — uses the same hook to place the line listing an agent's open questions to the user before the input that starts its run.
- `extensions/prompt/server.ts` — uses the same hook to place a "Build changed" note before the input that starts a run, keeping the build out of the cached system prompt.
- `extensions/conversations/server.ts` — uses the same hook to resume a concluded conversation in the commit that places its input.
- `extensions/plan/server.ts` — uses the same hook to empty a new branch's inherited plan in the commit that places its first input.
- `extensions/setup/server.ts` — uses the same hook to place changed setup warnings before the primary agent's input, recording the note and its deduplication state in one commit.
- `extensions/todos/server.ts` — uses the same hook to place a changed to-do list before @ultimate's input, recording the note and its deduplication state in one commit. Drop the coupling when Pi ships input-placement hooks.
- `extensions/models/server.ts` — uses the same hook to switch a conversation whose model lost its login before the run its input starts; the patch also routes a failed run's afterFailedRun "continue" boundary through it.
- `extensions/goal/server.ts` — uses the patched transactional beforeInput hook to place an open hands-off goal's note before @ultimate's input. Drop the coupling when Pi ships input-placement hooks.
- `extensions/backup/server.ts` — uses the patched transactional beforeInput hook to switch a conversation from its backup model back to its primary before the run its input starts, with the note saying so. Drop the coupling when Pi ships input-placement hooks.
- `extensions/pause/server.ts` — uses the patched Harness.hold()/release() for the user's soft pause. Drop the patch when Pi Durable ships a scheduler hold.
- `extensions/dream/server.ts` — uses the patched Harness.hold() after approving a chapter switch so no new tasks start before the replacement core takes over. Drop the coupling when Pi Durable ships a scheduler hold.
- `extensions/coding-tools/revision.ts` — `read {rev}` runs Pi's read tool over an environment whose openBinaryReader returns the committed bytes, relying on the tool loading content only through it. Drop when Pi's read tool accepts a reader or a revision.
- `extensions/coding-tools/diff.tsx` — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
- `extensions/prompt/server.ts` — tool guidance adapted from unexported prompt contributions, not Ultimate's personality. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
- `web/src/app/model.ts` — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
- `web/src/sdk/format.ts` — copied formatTokens helper, not exported. Drop when Pi exports formatTokens.
- `web/src/sdk/events.ts` — adapted Pi event bus using browser-safe sets instead of node:events, with Pi's exported EventBus type and handler-error semantics. Drop when Pi ships a browser-safe bus.
- `extensions/coding-tools/web.tsx` — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
- `extensions/context/breakdown.ts` — internal remove-all pi.system entry immediately precedes a reordered re-add, folded into the re-add's diff here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
- `extensions/fast/server.ts` — sets service_tier through onPayload because pi-ai's simple stream options drop serviceTier. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
- `server/tool-arguments.ts` — ends degenerate tool-call argument streams with an error worded to match pi-ai's retryable error pattern, so the generation retries it. Drop the wording when Pi Durable lets a stream mark its error retryable.
- `lib/chapters.ts` — raises a new chapter's durable_metadata.next_id so record ids continue across chapters, and reads a closed chapter's live foreground tasks from the tasks table to refuse a switch into it. Drop when Pi Durable takes a first record id when it creates storage and reads a closed store's task graph.
- `extensions/codemode/chapters.ts` — reads closed chapters' conversation and entry JSON records, follows fork cutoffs, and replays metadata document revisions with read-only SQL. Drop when Pi's SQLite storage opens over a read-only connection: 1.5.2's `HarnessOptions.readOnly` still writes the file (WAL mode, migrations, a checkpoint on close).
- `extensions/codemode/search.ts` — `ultimate.search` matches `entries.record` with SQL `instr()` in a worker on a read-only connection, relying on each record being exactly `JSON.stringify(entry)` and following fork cutoffs like `readEntries`. Revisit when Pi changes how it encodes entry records or offers a substring search over them.
- `.ultimate/skills/measure-switch/copy-paused.ts` — writes a pause.state version-2 base revision into a scratch database's document_revisions and advances durable_metadata.next_seq, relying on Pi Durable's SQLite schema and chord operation format. Drop when Pi exposes an offline document-update API.
- `extensions/subagents/server.ts` — internal ToolTaskInput.assistant locates the calling assistant for history forks. Drop when ToolExecutionApi exposes the calling assistant entry ID.
- `server/skills.ts` — copies AgentSession's unexported _expandSkillCommand block format for /skill:name invocation. Drop when Pi exports the skill command expansion.

On a Pi upgrade, run `rg "Pi upstream:"` and recheck each marked item against the new version; `scripts/pi-upstream.ts` (part of `pnpm check`) checks that every tracked marker matches the installed package version and its path appears in this list, and the backticked path each entry starts with is tracked and contains a marker; backticks later in an entry are prose.
Delete copies and patches that Pi now exports or fixes, then update the remaining markers and this list after verification.

## Message threads and cache warming

pi-ai 1.5.1 shipped what Pi's changelog had announced for 1.6 (read at `main` c9dd2c5, 2026-11-09). The decision
(#191455): **message threads stay off** until a provider smoke says otherwise; turning them on is the user's call. Idle
cache warming needs no setting, because nothing in Ultimate runs it.

- **Message threads** (`message-threads-2026-08-12` beta, pi-ai `src/api/anthropic-messages.ts`): a request with a
  `sessionId` and `cacheRetention` other than `"none"` continues a server-side thread and sends only the new messages.
  Anthropic holds the conversation, system prompt and tools in memory for up to an hour; the feature is not ZDR
  eligible. On by default only for provider `anthropic` on `api.anthropic.com`, API key and subscription login alike;
  `compat.supportsMessageThreads` in `~/.pi/agent/models.json` changes it. Pi Durable sends a per-conversation
  `sessionId` on every generation, so the default threads every `anthropic` turn. Compaction summaries
  (`cacheRetention: "none"`) and Ultimate's own calls without a `sessionId` (keep-warm, the summary model, lineage's
  ask) are never threaded. Price and token counts do not change.
- **Off is a machine setting:** `"anthropic": { "compat": { "supportsMessageThreads": false } }` under `providers` in
  `~/.pi/agent/models.json`. A machine without it gets Pi's default.
- **Cache warming** (`cacheWarming`, `"idle"` by default): read only by pi-coding-agent's `CacheWarmer`, which
  `createAgentSession` builds. Ultimate uses neither, and Pi Durable has no warmer, so the default costs nothing here.
  It applies to the `pi` CLI on the same machine, through `~/.pi/agent/settings.json`.

Checked at the 1.5.2 upgrade (#255679, 2026-11-12):

1. The release kept the names and defaults: `compat.supportsMessageThreads` (default on for `anthropic` at
   `api.anthropic.com`), `cacheWarming: "idle"` in pi-coding-agent's settings defaults,
   `StreamOptions.disableContinuation`.
2. The pin holds on the host: through `ModelRuntime` all 18 `anthropic` models have
   `compat.supportsMessageThreads === false`, and pi-ai adds the beta and a `thread` only for a session it took under
   that flag. Not checked on a real turn's `betas` (Wire or the `ultimate-provider-smoke` skill).
3. Pi Durable still has no cache warmer (`rg -L --no-ignore -i cachewarm node_modules/@earendil-works/pi-durable/dist`
   finds nothing) and Ultimate does not call `createAgentSession`. If either changes, idle warming spends money
   between runs: decide `cacheWarming` before landing.

Before anyone turns threads on, a smoke on the subscription login answers what is still open:

- whether subscription OAuth accepts the threads beta (Pi turns threads off for the session after a rejection, one
  failed request each);
- whether Claude Code itself sends this beta: if not, OAuth requests differ from the client they present as, which is
  an account risk;
- whether a threaded turn and an unthreaded request (a keep-warm ping, a full resend) share one prompt cache, since
  their beta lists differ: the ping's `cacheRead` must cover @ultimate's prefix;
- whether a threaded turn keeps the one-hour cache keep-warm gives @ultimate (`hourCache` in
  `extensions/keep-warm/server.ts` sets `ttl: "1h"` on the breakpoints of the body pi-ai built): its usage must still
  show `cacheWrite1h`;
- what the first request after a gap of over 5 minutes costs: the thread has expired, the continue is rejected
  (`thread_not_found`) and Pi resends in full.

## Searching Pi's code

The Pi packages live under `node_modules/@earendil-works/<pkg>` (pnpm symlinks). Only pi-claude-code ships its TypeScript
source; the others ship type declarations and compiled JS, so start in the `.d.ts` files, whose doc comments carry the
contracts.

| Package           | Types and compiled JS          | Also                                 |
| ----------------- | ------------------------------ | ------------------------------------ |
| `pi-durable`      | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `CHANGELOG.md`          |
| `pi-ai`           | `dist/*.d.ts`, `dist/*.js`     | `README.md`                          |
| `pi-coding-agent` | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `docs/`, `examples/`    |
| `pi-claude-code`  | none: `src/*.ts` is the source | `README.md`, `ARCHITECTURE.md`       |
| `chord`           | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `docs/`, `CHANGELOG.md` |
| `pi-schema`       | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `CHANGELOG.md`          |
| `pi-codemode`     | `dist/*.d.ts`, `dist/*.js`     | `README.md`                          |
| `pi-mcp`          | `dist/*.d.ts`, `dist/*.js`     | `README.md`, `CHANGELOG.md`          |

A search from the repository root skips them, because `node_modules` is gitignored and its entries are symlinks. Follow
symlinks, override the ignore files, and skip nested dependencies and source maps:

```bash
rg -L --no-ignore -g '!node_modules' -g '!*.map' -n '<term>' node_modules/@earendil-works
```

Narrow it to one package with `node_modules/@earendil-works/<pkg>`.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
