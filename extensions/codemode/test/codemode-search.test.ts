import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { Cursor, EntryRecord, Harness } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { context, prepareHarness } from '../../../server/harness.ts'
import { temp } from '../../../test/helpers.ts'
import { searchDatabase } from '../search.ts'
import type { SearchRequest } from '../search.ts'

// Before #199903 search walked every entry through the harness and matched `JSON.stringify(entry)` in JavaScript. The
// SQL search must find exactly what that walk found, in its order, with its excerpts.
async function walk(
  harness: Harness,
  text: string,
  options: Omit<SearchRequest, 'database' | 'text'>,
) {
  const matches: unknown[] = []
  const ids = options.conversationId === undefined ? [] : [options.conversationId]
  if (!ids.length) {
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 100, cursor), context)
      ids.push(...page.items.map((record) => record.id))
      cursor = page.next
    } while (cursor)
  }
  for (const id of ids) {
    let cursor: Cursor | undefined
    do {
      const page = await (await harness.conversation(id as never, context))!.entries(
        {},
        100,
        cursor,
        context,
      )
      for (const entry of page.items as EntryRecord[]) {
        if (options.kinds && !options.kinds.includes(entry.kind)) continue
        const json = JSON.stringify(entry)
        const at = json.indexOf(text)
        if (at < 0) continue
        const start = Math.max(0, at - 80)
        const end = Math.min(json.length, at + text.length + 120)
        const time = entry.model?.[0]?.timestamp
        matches.push(
          options.full
            ? entry
            : {
                conversation: entry.conversationId,
                id: entry.id,
                kind: entry.kind,
                ...(typeof time === 'number' && { at: new Date(time).toISOString() }),
                excerpt: `${start > 0 ? '…' : ''}${json.slice(start, end)}${end < json.length ? '…' : ''}`,
              },
        )
        if (matches.length === options.count) return matches
      }
      cursor = page.next
    } while (cursor)
  }
  return matches
}

it('finds what the JavaScript walk over entry JSON found, for quotes, escapes, umlauts, emoji and forks', async () => {
  const home = await temp('ultimate-codemode-search-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  const opened = await prepared.open(false)
  try {
    const { harness } = opened
    const tricky = [
      'say "hi" to C:\\Users\\me',
      'Grüße aus Köln — straße…',
      'emoji 🎉 and 😀 here',
      'line one\nline two\ttabbed',
      `${'x'.repeat(300)} needle-far ${'y'.repeat(300)}`,
      'nul \u0000 inside',
      'lone \ud83d surrogate',
    ]
    const parent = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
    let forkAt = 0
    for (const [index, text] of tricky.entries()) {
      const entry = await parent.commit(
        (tx) =>
          tx.appendEntry(parent.id, {
            kind: index % 2 ? 'search.note' : 'search.other',
            data: { text },
            model: [{ role: 'user', content: text, timestamp: 1_700_000_000_000 + index }],
          }),
        context,
      )
      if (index === 3) forkAt = entry.id
    }
    const fork = await parent.fork(forkAt as never, { ownership: { kind: 'ownerless' } }, context)
    await fork.commit(
      (tx) => tx.appendEntry(fork.id, { kind: 'search.note', data: { text: 'fork 🎉 "only"' } }),
      context,
    )
    await fork.commit((tx) => tx.appendEntry(fork.id, { kind: 'pi.reset', head: 'self' }), context)

    const queries = [
      '"hi"',
      '\\"hi\\"',
      'C:\\\\Users',
      'Grüße',
      'ö',
      '—',
      '…',
      '🎉',
      '\ud83d',
      '\\n',
      '\n',
      '\\t',
      '\\u0000',
      '\u0000',
      'needle-far',
      'search.note',
      '"kind":"search.other"',
      'no such text',
    ]
    const variants: Omit<SearchRequest, 'database' | 'text'>[] = [
      { count: 100 },
      { count: 2 },
      { count: 100, kinds: ['search.note'] },
      { count: 100, conversationId: fork.id },
      { count: 100, full: true },
    ]
    let found = 0
    for (const text of queries)
      for (const options of variants) {
        const expected = await walk(harness, text, options)
        found += expected.length
        expect({
          text,
          hits: searchDatabase({ database: prepared.chapter.database, text, ...options }),
        }).toEqual({ text, hits: expected })
      }
    expect(found).toBeGreaterThan(100)
  } finally {
    await opened.close()
  }
})
