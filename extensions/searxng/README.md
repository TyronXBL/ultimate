Search the public web through your own SearXNG instance with `web_search`, with Tavily as a capped fallback when SearXNG finds nothing, and read a public page as text with `web_fetch`. No API key needed; the fallback takes an optional `TAVILY_API_KEY`. Off by default; turn it on for a machine with `"extensions": { "enable": ["searxng"] }` in `~/.ultimate/settings.json`.

Enable only one of `searxng` or `parallel`: both provide `web_search` and `web_fetch`, and with both on, the one that loads second fails with "web_search is already provided by …".

## Settings

`searxng.url` in `~/.ultimate/settings.json` (user settings only, so no repository can point your queries at another server), default `http://127.0.0.1:8888`, for example `{ "searxng": { "url": "http://127.0.0.1:8888" } }`. The instance must answer JSON (`json` in `search.formats` of its `settings.yml`); when it does not, the tool says so.

## Run SearXNG without root

SearXNG installs from its git repository into a Python venv and runs as a `systemd --user` service bound to loopback:

```sh
mkdir -p ~/.local/share/searxng ~/.config/searxng ~/.config/systemd/user
git clone --depth 1 https://github.com/searxng/searxng.git ~/.local/share/searxng/src
python3 -m venv ~/.local/share/searxng/venv
~/.local/share/searxng/venv/bin/pip install -U pip setuptools wheel pyyaml msgspec typing_extensions
cd ~/.local/share/searxng/src && ~/.local/share/searxng/venv/bin/pip install --no-build-isolation -e .
(umask 077; echo "SEARXNG_SECRET=$(openssl rand -hex 32)" > ~/.config/searxng/secret.env)
```

`~/.config/searxng/settings.yml`:

```yaml
use_default_settings: true
server:
  bind_address: '127.0.0.1'
  port: 8888
  limiter: false
  image_proxy: false
search:
  formats: [html, json]
outgoing:
  source_ips: ['0.0.0.0']
  request_timeout: 5.0
  max_request_timeout: 10.0
engines:
  - name: yahoo
    disabled: false
  - name: duckduckgo
    disabled: true
  - name: github
    categories: [general, it]
  - name: stackoverflow
    categories: [general, it]
  - name: mdn
    categories: [general, it]
```

This profile is tuned for a server's IP address (measured in `docs/research/web-search-reliability.md`): DuckDuckGo answers such addresses with a CAPTCHA on almost every query, so it is off; Yahoo, off by default, is on as a third web engine beside Brave and Google CSE; GitHub, Stack Overflow and MDN answer general searches as well as `it`. Outgoing requests use IPv4 (`source_ips: ['0.0.0.0']`); the five-second per-engine timeout and ten-second cap bound slow searches. Engine suspension times stay SearXNG's defaults (180 s after a rate limit); `web_search` sends at most two searches at once, machine-wide, to stay under those limits. Engine names vary by SearXNG release; check them against the installed `searx/settings.yml` after an update.

For a live user config, preserve a copy before editing and restart the user service after changes:

```sh
cp -p ~/.config/searxng/settings.yml ~/.config/searxng/settings.yml.before-profile
systemctl --user restart searxng
```

Keep `secret.env` unchanged. The update automation refreshes the source and venv and restarts the service; it does not write `settings.yml`.

`~/.config/systemd/user/searxng.service`:

```ini
[Unit]
Description=SearXNG (loopback, for Ultimate web_search)
After=network-online.target

[Service]
Environment=SEARXNG_SETTINGS_PATH=%h/.config/searxng/settings.yml
EnvironmentFile=%h/.config/searxng/secret.env
ExecStart=%h/.local/share/searxng/venv/bin/searxng-run
Restart=on-failure
MemoryMax=512M

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now searxng`. To keep it running without a login session, lingering must be on (`loginctl enable-linger <user>`, which may need an administrator). It uses about 100–150 MB of memory and next to no CPU while idle. Update it now and then (`git pull`, the `pip install -e .` line, `systemctl --user restart searxng`): its engines scrape public search sites, which change.

## Tools

`web_search { query, count?, categories?, time_range? }` returns ranked pages (title, URL, domain, snippet, publication date), at most 25 (default 10), with a 15-second timeout and cancellation. When upstream engines are unresponsive (rate limits, CAPTCHAs), it names them: the result set may be incomplete. Queries leave the machine through the instance to the engines it aggregates. Every Ultimate on the machine, previews included, runs at most two searches at once; a third waits for a free place without saying so (`web-search-admission.sqlite` in `~/.ultimate`).

### Tavily fallback

When SearXNG returns no results, or every web engine it would ask (those in the `web` category for the search's categories) reports a failure, `web_search` asks [Tavily](https://tavily.com) instead, in the same tool and result shape. The text says `Results from Tavily (fallback n/1,000 this month)`, each result's `engine` is `tavily`, and the card shows `via Tavily`. SearXNG's categories and time range do not apply to it, and it returns at most 20 results.

- **The key:** `TAVILY_API_KEY` in the Secrets panel (⌘K → Secrets); a free account needs no card. Without it, search works as before, the setup item offers the key, and a search that needed the fallback says it is not configured.
- **The cap:** 1,000 calls per calendar month (UTC), one budget for every project and preview on the machine, the free tier's size, so it costs nothing. Each call is counted before it is sent, also when it fails, in `~/.ultimate/tavily-budget.sqlite`; when it is used up the tool says so until the 1st. Tavily resets its free credits on the 1st too, and stops (it does not bill) when they run out. Deleting the file resets the local count; an unreadable file stops the fallback until it is repaired or removed.
- **What leaves the machine:** only the query text, plus fixed options (basic search, 20 results), and only for searches SearXNG failed, to `https://api.tavily.com`. Tavily's terms (§6.5) may let it train on what it receives.
- **Outages are errors:** when every SearXNG web engine failed and the fallback cannot answer (no key, cap used up, a Tavily error), the call is a tool error naming each cause: `Web search is down: every SearXNG web engine failed (…). …`. An empty result otherwise stays a success. SearXNG does not report which engines answered with nothing, so the text says so rather than claiming a real empty result.

### Measuring

Every `web_search` result's `details.outcome` is one of `good` (results, no engine down), `partial` (results, some engines down), `fallback` (answered by Tavily), `unknown-empty` (no results, no proven outage), `outage` (the error above) or `cancelled`; `details.fallback` says what the fallback did when it was needed (`answered`, `no-results`, `not-configured`, `cap-reached`, `budget-unavailable`, `secrets-unreadable`, `failed`). The weekly count, in codemode across the running projects:

```js
const since = Date.now() - 7 * 86_400_000
const counts = {}
for (const { name, running } of await ultimate.projects()) {
  if (!running) continue
  const hits = await ultimate.search('"toolName":"web_search"', {
    kinds: ['pi.tool-result'],
    full: true,
    limit: 1000,
    project: name,
  })
  for (const { model } of hits)
    for (const result of model ?? []) {
      if (result.toolName !== 'web_search' || result.timestamp < since) continue
      const key = `${result.details?.outcome ?? 'untagged'}${result.details?.fallback ? `/${result.details.fallback}` : ''}`
      counts[key] = (counts[key] ?? 0) + 1
    }
}
return counts
```

The target is fewer than 2% `unknown-empty`. Tavily calls this month: `sqlite3 ~/.ultimate/tavily-budget.sqlite 'SELECT * FROM budget'`.

`web_fetch { url, max_chars? }` reads one page: HTML becomes markdown-like text (title, then only the main content when the page marks it with `<main>` or `role="main"`; headings, paragraphs, list items, absolute links, verbatim `pre`; scripts, styles, `nav`, `footer`, `role="navigation"` and hidden elements dropped), text and JSON come back as they are, other content types are refused. It follows up to 5 redirects, times out after 15 seconds and reads at most 5 MB.

It reads public addresses only. It refuses non-http(s) URLs, credentials in URLs, and loopback, private, link-local, shared (100.64/10), documentation, multicast and reserved addresses, IPv4 and IPv6, and IPv6 forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4). A host name is checked against every address it resolves to when the connection is made, so DNS rebinding cannot slip past the check, and each redirect target is checked again. For localhost, APIs or binary files, use curl.

Both tools are read-only. `web_fetch` is replay-safe; `web_search` is not, since a fallback spends a counted call: one interrupted by a restart reports "interrupted" instead of running again. Both cap text output at 50 KiB / 2000 lines. An unreachable or misconfigured instance produces a tool error naming the setting, plus one process-local notice.

## UI

`web_search` renders collapsed while it succeeds: the query, the top three domains and `n results`; expanded, each result's title as a link, its domain, date and a three-line excerpt. Unresponsive engines show as `n engines down` in the header and one warning line each; results from the fallback show `via Tavily`. `web_fetch` shows the URL and the text's size; expanded, the page title, its link and the text, as markdown for HTML. Failed calls open themselves to show the error. The cards request nothing from the web: links load only when followed, and fetched text renders without images.

## Verify

`curl "http://127.0.0.1:8888/search?q=test&format=json"` must return JSON with a `results` array; then ask Ultimate to search for something and to read one of the results.
