import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../../../../server/harness.ts'
import { removeTemp, temp } from '../../../../test/helpers.ts'
import { searchChapter } from '../../search.ts'

// #199903: a search over a whole chapter in JavaScript on the main thread froze the host for 1.86 s. In its worker it
// must leave the event loop free, and the host's writes beside its read connection must neither fail nor wait.
// The writes prove both: a search on this thread would hold them back. Timer gaps proved nothing more and were noise:
// the host's own writes are synchronous `node:sqlite` calls on this thread, and a loaded CI runner saw a 159 ms gap
// in a 283 ms search (#265478).
it('a long search neither fails nor delays host writes, and sees them', async () => {
  const home = await temp('ultimate-codemode-search-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened = await prepared.open(false)
  const id = (
    await opened.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  ).id
  await opened.close()
  const database = prepared.chapter.database
  // About 120 MB of entries, written directly: through the harness they would take minutes. next_id moves past them.
  const db = new DatabaseSync(database)
  const { next_id, next_seq } = db
    .prepare('SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1')
    .get() as { next_id: string; next_seq: number }
  const first = Number(next_id)
  const count = 60_000
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
     INSERT INTO entries (id, conversation_id, head, commit_seq, record)
     SELECT ? + i, ?, NULL, ?, json_object('id', ? + i, 'conversationId', ?, 'kind', 'load.note',
       'data', json_object('text', printf('%.2000c', 'x'))) FROM n`,
  ).run(count, first, id, next_seq - 1, first, id)
  db.prepare('UPDATE durable_metadata SET next_id = ? WHERE singleton = 1').run(
    String(first + count),
  )
  db.close()
  opened = await prepared.open(false)
  try {
    const conversation = (await opened.harness.conversation(id, context))!
    const search = { done: false, ms: 0 }
    const began = performance.now()
    const searching = searchChapter(
      { database, text: 'no such text', count: 100 },
      undefined,
    ).finally(() => {
      search.done = true
      search.ms = performance.now() - began
    })
    const writes: number[] = []
    while (!search.done) {
      const at = performance.now()
      await conversation.commit(
        (tx) =>
          tx.appendEntry(id, { kind: 'load.write', data: { text: `write-${writes.length}` } }),
        context,
      )
      writes.push(performance.now() - at)
      await sleep(5)
    }
    expect(await searching).toEqual([])
    // A scan on this thread would block for the whole search (984 ms of 1.2 s, measured in #214751): no write would
    // land during it, or each would wait behind it.
    expect(writes.length).toBeGreaterThan(2)
    expect(writes.toSorted((a, b) => a - b)[writes.length >> 1]).toBeLessThan(20)
    // No write waits behind the search: the slowest is held against the search's own length, not a fixed time, which a
    // busy 2-CPU CI runner missed by a pause of its own (378 ms against 250, #273712).
    expect(Math.max(...writes)).toBeLessThan(search.ms / 2)
    // A write the host committed is found by the next search.
    expect(
      await searchChapter(
        { database, text: `write-${writes.length - 1}`, count: 100, kinds: ['load.write'] },
        undefined,
      ),
    ).toEqual([expect.objectContaining({ conversation: id, kind: 'load.write' })])
  } finally {
    await opened.close()
    await removeTemp(home)
  }
})
