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
- `settledMs` and `longMs` are the user-facing numbers; `eventKb` shows what the server sends. A tab keeps one event
  stream and a switch only resubscribes on it, so `streams` (new streams during the switch) should stay 0.
- The first line, `identity`, is what was measured: the preview checkout's full `sha` and `uncommitted` files, the
  server build (`serverBuild`), the web bundle the page ran (`webBundle`, a digest of its files), Chromium and machine
  load. `switch.ts` refuses to measure while the page and the server disagree on the bundle or one is building.
- The profile is of the production bundle: minified code and React's production build. `switch.ts` resolves every
  function's position through the bundle's source maps while the preview still serves them, and stores the result in
  the profile. The summary splits self time into `app` (mapped to web/src, extensions or generated facet modules),
  `dependency <package>`, `native` (DOM calls, V8 builtins, GC) and `unmapped <script>`, code no map covers (the
  bundler's runtime, Vite's preload helper), which stays unattributed. The app list is inclusive, so the app code
  behind native and dependency time shows there.

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
