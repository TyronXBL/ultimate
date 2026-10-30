Pins the user turn an answer replies to at the top of the transcript while the reader scrolls up through that answer.

## Server (`server.ts`)

`inputs` (`InputsAction` in `refs.ts`): a conversation's own inputs below an entry, newest first, 64 at most, without
the entries between them and without images. The pin reads it when the turn being answered lies below the loaded
history, so the browser never pages in every row of a long answer to find it.
