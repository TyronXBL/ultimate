Sign in to an OpenCode Go subscription in the browser. Pi's built-in `opencode-go` provider gets a second login next to
its API key: **Log in → OpenCode Go → Sign in with OpenCode** shows a device code (the models extension's login
dialog), you approve it on opencode.ai, and pick the workspace that holds the Go subscription when there is more than
one. Its models then work like any other provider's: picker, families, backups.

- **Login** (`login.ts`): the OpenCode Console's device flow with the OpenCode CLI's public client id (`opencode-cli`),
  asking for a workspace-scoped grant. The workspace the Console scoped it to wins, then the only one; otherwise a
  `select` prompt lists workspaces by name, with indexes as option ids so no workspace id reaches the login document.
  The credential (`~/.pi/agent/auth.json`, as every Pi login) keeps the token, refresh token and workspace id; Pi
  refreshes it under its lock five minutes before it expires.
- **Requests** stay Pi's: same catalogue, same `x-opencode-session` header and same client identity, with
  `models.json` applied on top as before. The login only supplies the bearer token and `x-opencode-org-id`. The
  catalogue is the one Pi ships (`opencodeGoProvider()`), so it changes with Pi upgrades; Pi's between-release
  catalogue updates from pi.dev do not reach this provider.
- **Subscription:** the login counts as a subscription (`isSubscription`), so a conversation on it only falls back to
  another subscription. An API key stays pay-per-token as before.
- **Reload:** each facet registers the provider again; the last one to close unregisters it, which restores Pi's own.

OpenCode documents API keys for other agents; this login borrows its CLI's and may stop working if OpenCode
restricts it. The API key login keeps working either way. Go's own free models (such as `beam-free`) run through
either login. OpenCode's Zen free tier is limited to the OpenCode app and is not covered.
