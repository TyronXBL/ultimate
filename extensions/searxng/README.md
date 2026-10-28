Search the public web through your own SearXNG instance with `web_search`, and read a public page as text with `web_fetch`. No API key. Off by default; turn it on for a machine with `"extensions": { "enable": ["searxng"] }` in `~/.ultimate/settings.json`.

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
```

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

`web_search { query, count?, categories?, time_range? }` returns ranked pages (title, URL, domain, snippet, publication date), at most 25 (default 10), with a 15-second timeout and cancellation. When upstream engines are unresponsive (rate limits, CAPTCHAs), it names them: the result set may be incomplete. Queries leave the machine through the instance to the engines it aggregates.

`web_fetch { url, max_chars? }` reads one page: HTML becomes markdown-like text (title, then only the main content when the page marks it with `<main>` or `role="main"`; headings, paragraphs, list items, absolute links, verbatim `pre`; scripts, styles, `nav`, `footer`, `role="navigation"` and hidden elements dropped), text and JSON come back as they are, other content types are refused. It follows up to 5 redirects, times out after 15 seconds and reads at most 5 MB.

It reads public addresses only. It refuses non-http(s) URLs, credentials in URLs, and loopback, private, link-local, shared (100.64/10), documentation, multicast and reserved addresses, IPv4 and IPv6, and IPv6 forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4). A host name is checked against every address it resolves to when the connection is made, so DNS rebinding cannot slip past the check, and each redirect target is checked again. For localhost, APIs or binary files, use curl.

Both tools are read-only and replay-safe, and cap text output at 50 KiB / 2000 lines. An unreachable or misconfigured instance produces a tool error naming the setting, plus one process-local notice.

## UI

`web_search` renders collapsed while it succeeds: the query, the top three domains and `n results`; expanded, each result's title as a link, its domain, date and a three-line excerpt. Unresponsive engines show as `n engines down` in the header and one warning line each. `web_fetch` shows the URL and the text's size; expanded, the page title, its link and the text, as markdown for HTML. Failed calls open themselves to show the error. The cards request nothing from the web: links load only when followed, and fetched text renders without images.

## Verify

`curl "http://127.0.0.1:8888/search?q=test&format=json"` must return JSON with a `results` array; then ask Ultimate to search for something and to read one of the results.
