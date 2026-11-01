import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Branch, Roots } from '../extensions/lineage/api.ts'
import { rootOf } from '../extensions/lineage/server.ts'
import { parseDefinition } from '../lib/agents.ts'
import { seedTally, until } from './helpers.ts'
import { fixture, dead, entries, log, ask } from './ultimate-fixture.ts'

it('starts a lineage branch with a message input and caller attribution, returns its answer, and selects roots', async () => {
  const f = await fixture()
  await seedTally(f.server.harness)
  const ultimate = await f.subagents.standing('ultimate', context)
  // A project overlay pins the coordinator's model; `max` exceeds what the model supports and clamps to `high`. Its
  // `addTools` loads the deferred `debug`, though the coordinator has no tool list.
  const overlay = join(f.root, '.ultimate/agents/coordinator.md')
  await writeFile(
    overlay,
    '---\nname: coordinator\nmodel: faux/faux-think\nthinking: max\naddTools: [debug]\n---\n',
  )
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Explore the task', isolated: false }),
  )
  await until(async () =>
    (await log(f.server)).some((m) => m.from === ultimate && m.text === 'Explore the task'),
  )
  const message = (await log(f.server)).find((m) => m.text === 'Explore the task')!
  const branch = message.to as ConversationId
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) => entry.kind === 'board.reply'),
  )
  expect(await f.server.harness.snapshot(Branch, branch, context)).toMatchObject({
    branch: { from: 1, intent: 'Explore the task' },
  })
  expect(
    (await entries(f.server, branch)).filter((entry) => entry.kind === 'board.message'),
  ).toMatchObject([{ data: { from: ultimate, text: 'Explore the task', reply: true } }])
  expect(await f.server.harness.snapshot(Metadata, branch, context)).toMatchObject({
    title: 'Explore the task',
    label: 'coordinator',
  })
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some((entry) =>
      JSON.stringify(entry).includes(`started by #${ultimate} (@ultimate)`),
    ),
  ).toBe(true)
  const other = await f.server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await seedTally(f.server.harness, other.id)
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Ambiguous', isolated: false }),
  )
  expect(f.requests.some((text) => text.includes(`Choose a root. Roots: #1, #${other.id}`))).toBe(
    true,
  )
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Invalid', root: 999, isolated: false }),
  )
  expect((await log(f.server)).some((m) => m.text === 'Invalid')).toBe(false)
  await ask(
    f.server,
    ultimate,
    'BRANCH ' + JSON.stringify({ prompt: 'Explicit root', root: other.id, isolated: false }),
  )
  await until(async () => (await log(f.server)).some((m) => m.text === 'Explicit root'))
  expect(await rootOf({ harness: () => f.server.harness }, branch, context)).toBe(1)
  // A branch caller's tree wins over an ambiguous project root list.
  const branchConversation = (await f.server.harness.conversation(branch, context))!
  const configured = await branchConversation.agent(context)
  const coordinator = parseDefinition(
    await readFile(resolve('agents/coordinator.md'), 'utf8'),
    'coordinator',
  )
  expect(coordinator.resident).not.toBe(true)
  expect(coordinator.tools).toBeUndefined()
  expect(coordinator.model).toBeUndefined()
  expect(configured.instructions).toBe(coordinator.instructions)
  expect(configured.model).toEqual({ provider: 'faux', modelId: 'faux-think' })
  expect(configured.thinkingLevel).toBe('high')
  expect(configured.tools.map((tool) => tool.name)).toContain('debug')
  expect(configured.tools.map((tool) => tool.name)).not.toContain('branch')
  const agentBranch = (await f.server.root.agent(context)).deferred.find(
    (tool) => tool.name === 'branch',
  )!
  await f.server.harness.commit(
    (tx) => configure(tx, branch, { modelTools: { add: [agentBranch] } }),
    context,
  )
  // A user definition without a pin: the branch starts on the default model, never on a root model that lost its
  // login (rog, 2026-10-25: branches inherited the root's OpenRouter model after its login was removed).
  await f.server.harness.commit(
    (tx) =>
      configure(tx, ROOT_CONVERSATION_ID, { model: { provider: 'openrouter', modelId: dead } }),
    context,
  )
  await rm(overlay)
  await writeFile(
    join(f.home, '.ultimate/agents/coordinator.md'),
    '---\nname: coordinator\ndescription: Custom coordinator\n---\nUse the project procedure.',
  )
  await ask(f.server, branch, 'BRANCH ' + JSON.stringify({ prompt: 'Same tree', isolated: false }))
  await until(async () => (await log(f.server)).some((m) => m.text === 'Same tree'))
  const sameTree = (await log(f.server)).find((m) => m.text === 'Same tree')!
  expect(
    await f.server.harness.snapshot(Branch, sameTree.to as ConversationId, context),
  ).toMatchObject({ branch: { from: 1 } })
  const overridden = await (await f.server.harness.conversation(
    sameTree.to as ConversationId,
    context,
  ))!.agent(context)
  expect(overridden.instructions).toBe('Use the project procedure.')
  const rootAgent = await f.server.root.agent(context)
  expect(overridden.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect(overridden.thinkingLevel).toBe(rootAgent.thinkingLevel)
  expect(overridden.tools.map((tool) => tool.name)).toEqual(
    configured.tools.map((tool) => tool.name).filter((name) => name !== 'debug'),
  )
  // The branch's later run (woken by its child's reply) routes its answer to its starter as a note.
  await until(async () =>
    (await log(f.server)).some(
      (m) =>
        m.from === branch &&
        m.to === ultimate &&
        m.text === `Tool result: Branch #${sameTree.to} started; message ${sameTree.id} sent.`,
    ),
  )
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes(`Branch #${sameTree.to} started`),
    ),
  )
  await f.server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots = []
  }, context)
  await ask(f.server, ultimate, 'BRANCH ' + JSON.stringify({ prompt: 'No roots', isolated: false }))
  // The refusal is a tool result in @ultimate's transcript; a note may join the same request after it.
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) =>
      JSON.stringify(entry).includes('Choose a root. Roots: (none)'),
    ),
  )
})

it('refreshes standing definitions for numeric-address deliveries', async () => {
  const f = await fixture()
  const dice = await f.subagents.standing('dice', context)
  await writeFile(
    join(f.home, '.ultimate/agents/dice.md'),
    '---\nname: dice\ndescription: Dice\nresident: true\ntools: [message]\n---\nEdited numeric recipient.',
  )
  await ask(
    f.server,
    f.server.root.id,
    'SEND ' + JSON.stringify({ to: `#${dice}`, text: 'Fresh delivery' }),
  )
  await until(async () =>
    (await log(f.server)).some((m) => m.from === dice && m.text.includes('Fresh delivery')),
  )
  expect(await (await f.server.harness.conversation(dice, context))!.agent(context)).toMatchObject({
    instructions: 'Edited numeric recipient.',
  })
  await f.server.harness.waitForIdle(context)
})

it('refreshes standing definitions before delivering automatic replies', async () => {
  const f = await fixture(async (text, home) => {
    if (text.startsWith('Message from') && text.includes('\nRoll after edit\n'))
      await writeFile(
        join(home, '.ultimate/agents/ultimate.md'),
        (await readFile(resolve('agents/ultimate.md'), 'utf8')) + '\nEdited reply recipient.',
      )
  })
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(f.server, ultimate, 'SEND ' + JSON.stringify({ to: '@dice', text: 'Roll after edit' }))
  await until(() =>
    f.requests.some((text) => text.startsWith('Reply from') && text.includes('Roll after edit')),
  )
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  expect(agent.instructions).toContain('Edited reply recipient.')
  await f.server.harness.waitForIdle(context)
})
