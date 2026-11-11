---
name: measure-switch
description: Measure and profile how fast Ultimate's UI switches conversations, on a paused copy of the project's real database, in a real Chromium with a CDP CPU profile. Use when asked to make conversation switching, the sidebar or the transcript faster, or to check that a change did not make them slower.
---

# Measure conversation switches on real data

A fresh preview has a handful of conversations; the slow paths only show with a long history (thousands of
conversations, megabytes of list and view). This recipe copies the real database into a scratch home that opens
**paused**, runs a preview on it, and drives switches in Chromium against the production bundle the preview serves.

The copy holds private conversations: keep it outside the repository, never commit or paste its contents, and delete
it when done.

## 1. Copy the database, paused

```bash
SRC=~/.ultimate/projects/<project-home>/chapters/<name>/state.sqlite   # the first chapter is <project-home>/state.sqlite
node .ultimate/skills/measure-switch/copy-paused.ts $SRC $TMPDIR/switch-perf/home
```

It reads the source with `VACUUM INTO` (never moves or writes it) and appends a manual pause to the copy's root
`pause.state`, so queued inputs, interrupted runs and automations stay held instead of calling models. Run it from a
checkout whose `pause` extension matches the source's version. Pick the chapter with the shape you need:
`chapters.json` names them and the active one.

## 2. Start a preview on it and confirm the pause

`instance start {home: "<$TMPDIR>/switch-perf/home"}` (the expanded path), then:

```bash
curl -s -X POST -H 'content-type: application/json' -H "origin: $URL" -d '{"args":null}' \
  $URL/api/extensions/pause/actions/state
```

It must say `"paused":true`. If not, stop the instance at once.

## 3. Measure

```bash
node .ultimate/skills/measure-switch/switch.ts $URL 1 <id,id,...> --rounds 2 [--profile $TMPDIR/switch-perf/a.cpuprofile]
node .ultimate/skills/measure-switch/profile-summary.ts $TMPDIR/switch-perf/a.cpuprofile
```

- Pass at least two ids (with one, the warm round switches to the conversation already shown). Pick ids with different
  shapes: a long conversation, a lander, @ultimate, one with many subagents
  (`sqlite3 <copy> "select conversation_id, count(*) from entries group by 1 order by 2 desc limit 10"`).
- Round 0 is cold (never shown in the tab), later rounds warm (`store.show` paints the kept replica first).
- `paintMs` (the conversation's rows on screen), `settledMs` and `longMs` are the user-facing numbers; `eventKb` shows
  what the server sends. A tab keeps one event stream and a switch only resubscribes on it, so `streams` (new streams
  during the switch) should stay 0. `longMs` counts the task the switch starts in, where React draws it; numbers from
  before #202077 left that task out, so do not compare `longMs` or `maxLongMs` with them.
- `viewMs` is when the server's view arrives, which means something else per round: a cold switch has nothing to show
  before it, a warm one has painted the kept replica already and only refreshes it. Compare cold and warm on `paintMs`,
  never on `viewMs` (#202077: warm `viewMs` was twice the cold one while warm painted in half the time).
- `viewMs` splits into `askMs` (click until the page asks the server: it asks only after React has drawn the change,
  the whole kept transcript on a warm switch), `queueMs` (until the request leaves: a free connection), `serverMs`
  (until the server has sent the view) and `handleMs` (until the page handles the event: a busy main thread). `subs`
  counts how often the page asked for the view; each one makes the server read and send it whole. `-1` is a part that
  could not be measured.
- The first line, `identity`, is what was measured: the preview checkout's full `sha` and `uncommitted` files, the
  server build (`serverBuild`), the web bundle the page ran (`webBundle`, a digest of its files), Chromium and machine
  load. `switch.ts` refuses a run unless the page and server agree on a bundle that built whole (no build error, no
  facet left out) and no rebuild or reload happened during it.
- The profile is of the production bundle: minified code and React's production build. `switch.ts` resolves every
  function's position through the bundle's source maps while the preview still serves them, and stores the result in
  the profile. The summary splits self time into `app` (mapped to web/src, extensions or generated facet modules),
  `dependency <package>`, `native` (DOM calls, V8 builtins, GC), `virtual <module>` (a map naming no file) and
  `unmapped <script>`, code no map covers (the bundler's runtime, Vite's preload helper), which stays unattributed. The app list is inclusive, so the app code
  behind native and dependency time shows there.

### Interaction and streaming

A switch that paints sooner by drawing part of the transcript later moves work to after the paint. Two more scripts
measure what that costs and what a running answer costs, on the same preview:

```bash
node .ultimate/skills/measure-switch/scroll.ts $URL <id,id,...> [--rounds 2]
node .ultimate/skills/measure-switch/stream.ts $URL <id,id,...> [--chunks 120] [--every 100] [--profile out.cpuprofile] [--trace]
```

- `scroll.ts` scrolls up with the wheel right after each switch and reports the main thread's frames for 2 s: the
  longest gap, gaps over 50 ms, time lost to frames longer than one, and how far the view got (`movedPx`).
- `stream.ts` feeds the shown conversation a synthetic answer through the page's own event stream, one chunk every
  `--every` ms, and reports main-thread time per chunk less the same time without chunks. Compare a long and a short
  conversation to tell what scales with the transcript from what does not.

## 4. Compare two revisions

A difference is attributable only to what differs between the two identities.

1. Choose the baseline as the candidate's parent or `git merge-base <candidate> main`, never a later main: main moves
   (daily upstream merges), and a later main differs from the candidate by everything that landed since.
2. Run both on one preview home in one session, alternating, at least three runs each; compare medians. Numbers drift
   between sessions with machine load (`identity.loadavg`).
3. Switch the preview's checkout between them (`git switch --detach <sha>`, back with `git switch -`): web and
   extension changes rebuild the bundle; server changes (`server/`, `shared/`) need the instance stopped and started on
   the same home. Run the scripts from a checkout that has this version, for example main's, whatever the preview
   serves.
4. In the report, give both identities and `git log --oneline <baseline>..<candidate>`. When that range holds more
   than the change under test (a merge), the difference measures all of it: say so, rather than crediting the change.

## 5. Clean up

Stop the instance as soon as the runs are done, then `rm -rf $TMPDIR/switch-perf`. Nothing from the copy goes into
the repository.
