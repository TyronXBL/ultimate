import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { CompactionEntry } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { fauxServer, temp, trimmedSourceCopy } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
let server: Server
const usageLimit = 'Codex error: The usage limit has been reached'
/** Which faux models answer a summary with a usage limit. */
const limited = new Set<string>()

beforeAll(async () => {
  // Backup gives the summary its next model; the definition's fallback is faux-2.
  const ultimateRoot = await trimmedSourceCopy(await temp(), ['backup'])
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['backup'] } }),
  )
  await mkdir(join(ultimateRoot, 'agents'), { recursive: true })
  await writeFile(
    join(ultimateRoot, 'agents/summarized.md'),
    '---\nname: summarized\ndescription: Runs on faux-1, backed by faux-2.\nmodel: faux/faux-1\nfallback: [faux/faux-2]\n---\n\nAnswer.\n',
  )
  const home = await temp('ultimate-lineage-compaction-')
  server = await fauxServer({
    ultimateRoot,
    home,
    userHome: home,
    faux: fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] }),
  })
  const route: FauxResponseFactory = (_transcript, _options, _state, model) => {
    server.host.faux!.appendResponses([route])
    if (limited.has(model.id))
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: usageLimit })
    return fauxAssistantMessage(`SUMMARY by ${model.id}`)
  }
  server.host.faux!.setResponses([route])
})
afterAll(() => server?.close())

/** A conversation running as `summarized` on faux-1, with enough history to compact. */
async function conversation() {
  const created = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: { provider: 'faux', modelId: 'faux-1' } } },
    context,
  )
  const { id } = created
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, id)).label = 'summarized'
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  return created
}

// #109866 stalled: its backup was out of quota, and compaction summarised only on the conversation's own model.
it('summarises on the backup model when the conversation’s model hits its usage limit', async () => {
  limited.clear()
  limited.add('faux-1')
  const created = await conversation()
  const task = await server.harness.waitForTask(await created.compact(undefined, context), context)
  expect(task.state.outcome.status).toBe('completed')
  const [summary] = (await created.context(context)).entries
  expect(summary.kind).toBe(CompactionEntry.kind)
  expect(JSON.stringify(summary.model)).toContain('SUMMARY by faux-2')
  expect((await created.agent(context)).model).toEqual({ provider: 'faux', modelId: 'faux-1' })
})

it('fails naming every model tried, and keeps every entry, when no model can summarise', async () => {
  limited.clear()
  limited.add('faux-1').add('faux-2')
  const created = await conversation()
  const before = (await created.context(context)).entries.map((entry) => entry.id)
  const { outcome } = (
    await server.harness.waitForTask(await created.compact(undefined, context), context)
  ).state
  if (outcome.status !== 'failed') throw new Error(`Compaction ${outcome.status}`)
  const { message } = outcome.error
  expect(message).toContain(`faux/faux-1 (quota: ${usageLimit})`)
  expect(message).toContain(`faux/faux-2 (quota: ${usageLimit})`)
  expect((await created.context(context)).entries.map((entry) => entry.id)).toEqual(before)
})
