import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { parseDefinition } from '../lib/agents.ts'
import { seedTally, until } from './helpers.ts'
import { fixture, entries, ask } from './ultimate-fixture.ts'

it('ships a resident Ultimate definition with valid tools; standing addresses create recipients and name both sides', async () => {
  const f = await fixture()
  const definition = parseDefinition(
    await readFile(resolve('agents/ultimate.md'), 'utf8'),
    'ultimate',
  )
  expect(definition.resident).toBe(true)
  const ultimate = await f.subagents.standing('ultimate', context)
  const agent = await (await f.server.harness.conversation(ultimate, context))!.agent(context)
  // mcp exists only while mcpServers names a server; the fixture configures none.
  expect(agent.tools.map((tool) => tool.name).toSorted()).toEqual(
    definition.tools!.filter((name) => name !== 'mcp').toSorted(),
  )
  // debug is deferred: @ultimate names it, the root agent does not get it.
  expect(definition.tools).toContain('debug')
  const rootTools = (await f.server.root.agent(context)).tools.map((tool) => tool.name)
  expect(rootTools).not.toContain('branch')
  expect(rootTools).not.toContain('debug')
  expect(
    (await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.dice,
  ).toBeUndefined()
  await ask(f.server, ultimate, 'SEND ' + JSON.stringify({ to: '@dice', text: 'Roll' }))
  await until(async () =>
    (await entries(f.server, ultimate)).some((entry) => entry.kind === 'board.reply'),
  )
  const dice = (await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.dice
  expect((await entries(f.server, dice)).some((entry) => entry.kind === 'board.message')).toBe(true)
  expect(f.requests.some((text) => text.startsWith(`Message from #${ultimate} (@ultimate):`))).toBe(
    true,
  )
  await until(() =>
    f.requests.some((text) => text.startsWith(`Reply from #${dice} (@dice) to your message`)),
  )
  expect(
    (await (await f.server.harness.conversation(dice, context))!.agent(context)).tools.map(
      (tool) => tool.name,
    ),
  ).not.toContain('branch')
})

// Regression: a branch @ultimate started through codemode's lineage action got a plain prompt, so its answer never
// reached @ultimate. The action is gone; agents start branches with the `branch` tool.
it('has no lineage action that starts a branch without routing its answer', async () => {
  const f = await fixture()
  await seedTally(f.server.harness)
  const ultimate = await f.subagents.standing('ultimate', context)
  await ask(
    f.server,
    ultimate,
    `CODE return await ultimate.action('lineage', 'branch', { from: 1, prompt: 'Via action', isolated: false })`,
  )
  const result = (await entries(f.server, ultimate)).findLast(
    (entry) => entry.kind === 'pi.tool-result',
  )!
  expect(JSON.stringify(result.model)).toContain('Unknown extension action: lineage/branch')
  expect(
    (await entries(f.server, ROOT_CONVERSATION_ID)).some((entry) =>
      JSON.stringify(entry).includes('Via action'),
    ),
  ).toBe(false)
})
