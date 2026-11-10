import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { Owner } from '../extensions/models/set-model.ts'
import { context } from '../server/harness.ts'
import { servers, fixture, dead, entries, log, ask } from './ultimate-fixture.ts'

async function agentInstructions(f: Awaited<ReturnType<typeof fixture>>, id: ConversationId) {
  return (await (await f.server.harness.conversation(id, context))!.agent(context)).instructions
}

it('keeps Ultimate answers to messages replies out of the log, including after reopen', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  const resident = (await f.server.harness.conversation(ultimate, context))!
  const before = await log(f.server)
  const receipt = await resident.submit(
    {
      type: 'input',
      requestId: 'board-reply:quiet',
      content: 'Branch result',
      entry: {
        kind: 'board.reply',
        data: { id: 100, re: 99, from: 1, text: 'Branch result', failed: false },
      },
    },
    context,
  )
  expect(await receipt.wait(context)).toMatchObject({ status: 'done' })
  expect(
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes('Answer: Branch result'),
    ),
  ).toBe(true)
  expect(await log(f.server)).toEqual(before)
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  expect(await log(reopened)).toEqual(before)
})

it('notes an @ultimate overlay as changed instructions and applies its additions', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(f.server, ultimate, 'first')
  const overlay = join(f.home, '.ultimate/agents/ultimate.md')
  await writeFile(overlay, '---\nname: ultimate\naddTools: [write]\n---\n\nWrite notes freely.\n')
  await ask(f.server, ultimate, 'second')
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.instructions).toMatch(
    /^You are Ultimate[\s\S]*\n\n## User additions\n\nWrite notes freely\.$/,
  )
  // A Messages refresh applies the definition's tools, the overlay's included.
  await f.subagents.standing('ultimate', context)
  const refreshed = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(refreshed.tools.map((tool) => tool.name)).toContain('write')
  const [note] = (await entries(f.server, ultimate)).filter(
    (entry) => entry.kind === 'prompt.build',
  )
  expect(note.data).toEqual({ instructions: ['~/.ultimate/agents/ultimate.md'] })
  // Removing the overlay drops its additions and is named as an instruction change.
  await rm(overlay)
  await ask(f.server, ultimate, 'third')
  expect(await agentInstructions(f, ultimate)).not.toContain('## User additions')
  const [latest] = (await entries(f.server, ultimate)).filter(
    (entry) => entry.kind === 'prompt.build',
  )
  expect(latest.data).toEqual({ instructions: ['~/.ultimate/agents/ultimate.md (removed)'] })
})

it('re-applies an updated @ultimate definition on a typed input and notes changed instructions once', async () => {
  const f = await fixture()
  const ultimate = await f.subagents.standing('ultimate', context)
  const notes = async () =>
    (await entries(f.server, ultimate)).filter((entry) => entry.kind === 'prompt.build')
  const instructions = async () =>
    (await (await f.server.harness.conversation(ultimate, context))!.agent(context)).instructions
  // The first run records what it saw silently.
  await ask(f.server, ultimate, 'first')
  expect(await notes()).toEqual([])
  const path = join(f.root, 'agents/ultimate.md')
  await writeFile(path, (await readFile(path, 'utf8')) + '\nNew rule: delegate extensions.\n')
  await writeFile(join(f.root, 'docs/subagents.md'), 'Changed docs.\n')
  // A typed input, not a Messages delivery, picks up the new definition.
  await ask(f.server, ultimate, 'second')
  expect(await instructions()).toContain('New rule: delegate extensions.')
  const [note] = await notes()
  expect(note.data).toEqual({ instructions: ['agents/ultimate.md'], docs: ['docs/subagents.md'] })
  expect(note.model?.[0]?.content).toContain('Instructions changed: agents/ultimate.md')
  // The note comes once per change.
  await ask(f.server, ultimate, 'third')
  expect(await notes()).toHaveLength(1)
  // A definition a Messages delivery already applied, and a removed doc, are still named.
  await writeFile(path, (await readFile(path, 'utf8')) + '\nMessages rule.\n')
  await rm(join(f.root, 'docs/worktrees.md'))
  await f.subagents.standing('ultimate', context)
  expect(await instructions()).toContain('Messages rule.')
  await ask(f.server, ultimate, 'fourth')
  // Entries come newest first.
  expect((await notes())[0].data).toEqual({
    instructions: ['agents/ultimate.md'],
    docs: ['docs/worktrees.md (removed)'],
  })
  // Other conversations never get it.
  await writeFile(path, (await readFile(path, 'utf8')) + '\nAnother rule.\n')
  await ask(f.server, ROOT_CONVERSATION_ID, 'root')
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some(
      (entry) =>
        entry.kind === 'prompt.build' && JSON.stringify(entry.data).includes('instructions'),
    ),
  ).toBe(false)
})

it('switches a conversation whose pinned model lost its login to its definition pin at the next input, with a notice', async () => {
  const f = await fixture()
  await writeFile(
    join(f.home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\nmodel: faux/faux-think\ntools: [message]\n---\nAnswer concisely.',
  )
  const dice = await f.subagents.standing('dice', context)
  // The model it ran on lost its login (rog, 2026-10-25: conversations stuck on OpenRouter after its logout).
  await f.server.harness.commit(
    (tx) => configure(tx, dice, { model: { provider: 'openrouter', modelId: dead } }),
    context,
  )
  await ask(f.server, dice, 'roll')
  const agent = await (await f.server.harness.conversation(dice, context))!.agent(context)
  expect(agent.model).toEqual({ provider: 'faux', modelId: 'faux-think' })
  const fallbacks = (await entries(f.server, dice)).filter((e) => e.kind === 'models.fallback')
  expect(fallbacks.map((e) => e.data)).toEqual([
    { from: `openrouter/${dead}`, to: 'faux/faux-think', reason: 'pin' },
  ])
  // The run answered on the switched model, and a model with a login is left alone.
  expect(f.requests).toContain('roll')
  await ask(f.server, dice, 'again')
  expect((await entries(f.server, dice)).filter((e) => e.kind === 'models.fallback')).toHaveLength(
    1,
  )
})

it('keeps a model whose login check is pending or failed, and never trades a subscription for a pay-per-token login', async () => {
  const f = await fixture()
  const dice = await f.subagents.standing('dice', context)
  const fallbacks = async () =>
    (await entries(f.server, dice)).filter((e) => e.kind === 'models.fallback')
  const model = async () =>
    (await (await f.server.harness.conversation(dice, context))!.agent(context)).model
  const runtime = f.server.host.modelRuntime
  // omarchy-config, 2026-10-26: a Claude Code login the snapshot briefly lost switched @ultimate to a paid API key.
  // A fresh check that still finds the login, or that fails, is no evidence: the model stays and nothing is said.
  await f.server.harness.commit(
    (tx) => configure(tx, dice, { model: { provider: 'openrouter', modelId: dead } }),
    context,
  )
  const check = vi.spyOn(runtime, 'checkAuth').mockResolvedValueOnce({ type: 'api_key' })
  await ask(f.server, dice, 'pending')
  check.mockRejectedValueOnce(new Error('claude auth status timed out'))
  await ask(f.server, dice, 'failed')
  expect(await model()).toEqual({ provider: 'openrouter', modelId: dead })
  expect(await fallbacks()).toEqual([])
  check.mockRestore()
  // #534457/543286: with the claude-code provider not loaded during an outage, its login type was unknown, so the
  // subscription rule did not apply and a conversation moved to a pay-per-token provider. A provider that is not
  // registered is no evidence of a missing login: the model stays and nothing is said.
  const unloaded = { provider: 'not-loaded', modelId: 'faux-1' }
  await f.server.harness.commit((tx) => configure(tx, dice, { model: unloaded }), context)
  await ask(f.server, dice, 'unloaded')
  expect(await model()).toEqual(unloaded)
  expect(await fallbacks()).toEqual([])
  // A subscription whose login is really gone takes neither the pay-per-token default nor any first model in the
  // list: it keeps its model and asks once.
  const subscription = { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }
  await f.server.harness.commit((tx) => configure(tx, dice, { model: subscription }), context)
  await ask(f.server, dice, 'subscription')
  await ask(f.server, dice, 'again')
  expect(await model()).toEqual(subscription)
  expect((await fallbacks()).map((e) => e.data)).toEqual([
    { from: 'openai-codex/gpt-6.1-sol', reason: 'none' },
  ])
  // Another model without a login set meanwhile is asked about anew, and the wait keeps the owner the first one found.
  const other = { provider: 'openai-codex', modelId: 'gpt-6.1-luna' }
  await f.server.harness.commit((tx) => configure(tx, dice, { model: other }), context)
  await ask(f.server, dice, 'other')
  expect((await fallbacks()).map((e) => e.data)).toEqual([
    { from: 'openai-codex/gpt-6.1-luna', reason: 'none' },
    { from: 'openai-codex/gpt-6.1-sol', reason: 'none' },
  ])
  expect(await f.server.harness.snapshot(Owner, dice, context)).toEqual({
    by: 'login-wait',
    from: 'openai-codex/gpt-6.1-luna',
    under: { by: 'default' },
  })
})
