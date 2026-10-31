How much of each subscription login's usage limits is used, and when each limit resets: Claude (Anthropic login), OpenAI Codex, and any provider extension that adds its own source.

## Where the numbers come from

Each provider's own usage endpoint, called with the login's token as Pi's auth resolves it (`modelRuntime.getAuth`,
which refreshes it when due). Nothing is estimated: a share and a reset time are shown only when the provider reports
them.

- **Claude** (`anthropic`, OAuth login only): `GET api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's
  `/usage` reads. Its `limits` list gives the 5-hour session, the weekly limit and weekly limits scoped to one model,
  each with a used percentage and a reset time.
- **OpenAI Codex** (`openai-codex`): `GET chatgpt.com/backend-api/wham/usage`, the endpoint Codex's `/status` reads,
  with the account id from the token's claims as Pi's Codex provider sends it. Its `rate_limit` gives the 5-hour and
  weekly windows with used percentage and reset time, and the plan.
- **Another provider**: its extension calls `QuotaApi.register(source)` (`api.ts`) with a `read(apiKey, signal)` that
  returns the windows; the personal Antigravity wrapper does this with its package's `retrieveUserQuotaSummary`.

A login made with an API key has no plan limits and is not listed. The Claude Code provider (`claude-code`) logs in
through the Claude CLI, outside Pi's auth, so it is not listed either.

## When it reads

Only when asked: the status-line chip asks every minute and when its popover opens. A provider is read again when its
numbers are 5 minutes old, 1 minute after one of its answers (a `GenerationTask` `afterResponse` hook notes each one),
at once after an answer that is a limit (`limited` in `lib/rate-limit.ts`, as backup and pause classify it), and after
30 seconds when the popover opens. Readings live in memory, kept across reloads; nothing is written to disk.

A failed read keeps the numbers from the read before and says why in a fixed phrase ("HTTP 401", "network error",
"login could not be refreshed"): an error that could quote a response or a token never reaches the UI or the trace.

## Action

`state { fresh? }` → `{ providers: [{ provider, name, plan?, windows: [{ label, group?, used, resetsAt? }], at?, error? }] }`.
