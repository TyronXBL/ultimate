Pins the user turn an answer replies to at the top of the transcript while the reader scrolls up through that answer.

## Web (`web.tsx`)

A `transcript.top` component, so it sits in every transcript's reading column, a thread pane's included.

- **When**: while the reader is scrolled up and the top row on screen answers a user turn whose own start is off
  screen. At the bottom, or with that turn's start in view, nothing shows.
- **Which turn**: the newest user bubble at or above the top row, read from the DOM: core `UserView` marks each bubble
  with `data-turn-words` (the user's words, or a skill run's request), so typed turns, skill runs and messages that
  carry the user's words all count, and cards do not.
- **Below the loaded history** (core's `data-earlier-history` sentinel is present and no bubble is loaded above): it
  reads `inputs` and renders that page unseen through `TranscriptEntry`, as the transcript would, to find the newest
  input that shows as a user bubble, paging on until one does. Meanwhile the line says "finding your message…". In a
  thread pane (`useThread()`) it skips this: the stored inputs are the whole conversation's. The probe runs the real
  renderers, their effects included (a message card may read its images), and they see the loaded transcript, not the
  probed page. A failed read shows no pin below that entry for the rest of the view; it is not retried.
- **Look**: one 32 px line shaped like the user bubble (`border-border/70 bg-secondary/60`, `rounded-lg`), over a short
  fade so no cut-off text shows around it; the text is the first phrase, its first sentences up to 20 characters or
  else its first line.
- **Desktop**: a click emits `ultimate:reveal-entry`, which pages history down to the turn and scrolls to it.
- **Phone** (`useViewport() === 'phone'`): a tap on the words opens the whole message in place (six lines at most),
  so the reader keeps their place in the answer; the arrow beside it goes to the turn. Scrolling closes it.

## Server (`server.ts`)

`inputs` (`InputsAction` in `refs.ts`): a conversation's own inputs below an entry, newest first, 64 at most, without
the entries between them and without images. The pin reads it when the turn being answered lies below the loaded
history, so the browser never pages in every row of a long answer to find it.
