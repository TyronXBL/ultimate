import type { Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import ideasExtension, { actions, Ideas } from '../extensions/ideas/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const ULTIMATE = 5

/** A host over plain documents whose @ultimate is conversation 5 and records what is submitted to it. */
function fakeHost() {
  const docs = new Map<string, object>()
  const submitted: { requestId: string; whenBusy: string; content: string; entry: unknown }[] = []
  const tx = {
    doc: async (
      { definition: def }: { definition: { kind: string; initial: () => object } },
      id: number,
    ) => {
      const key = `${def.kind}:${id}`
      if (!docs.has(key))
        docs.set(
          key,
          def.kind === 'ultimate.standing-agents' ? { ultimate: ULTIMATE } : def.initial(),
        )
      return docs.get(key)
    },
    submissionByRequest: async (_id: number, requestId: string) =>
      submitted.find((input) => input.requestId === requestId),
  } as unknown as Tx
  const host = {
    doc: () => undefined,
    need: () => ({ standing: async () => ULTIMATE }),
    harness: () => ({
      commit: (fn: (tx: Tx) => unknown) => fn(tx),
      conversation: async () => ({
        submit: async (input: (typeof submitted)[number]) => void submitted.push(input),
      }),
    }),
  } as unknown as ExtensionHost
  return { host, tx, submitted }
}

const call = (host: ExtensionHost, action: keyof typeof actions, args: object) =>
  actions[action](args as never, { host } as never)

it('launches an idea into one input for @ultimate, which links the branch it started', async () => {
  const { host, tx, submitted } = fakeHost()
  const idea = await call(host, 'add', {
    title: ' Phone board ',
    notes: 'Stage pills',
    tags: ['#UI'],
  })
  expect(idea).toMatchObject({ id: 1, title: 'Phone board', tags: ['ui'], by: 'user' })

  await call(host, 'launch', { id: 1, size: 'assess' })
  // A second click before @ultimate linked a branch places nothing new.
  await call(host, 'launch', { id: 1, size: 'build' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatchObject({
    whenBusy: 'followUp',
    entry: { kind: 'ideas.launch', data: { id: 1, title: 'Phone board', size: 'assess' } },
  })
  expect(submitted[0].content).toContain('Assess first and build nothing.')
  expect(submitted[0].content).toContain("idea {action: 'link', id: 1, branch: <branch id>}")

  const tool = ideasExtension(host).tools!.find((candidate) => candidate.name === 'idea')!
  const run = (conversationId: number, args: object) =>
    tool.execute(
      args as never,
      { conversationId, commit: (fn: (tx: Tx) => unknown) => fn(tx) } as never,
      undefined as never,
    )
  await expect(run(9, { action: 'link', id: 1, branch: 40 })).rejects.toThrow('Only @ultimate')
  expect(await run(ULTIMATE, { action: 'link', id: 1, branch: 40 })).toEqual({
    output: [{ type: 'text', text: 'Linked idea 1 to #40' }],
  })
  expect(await run(ULTIMATE, { action: 'list' })).toEqual({
    output: [{ type: 'text', text: '- 1 [#40] Phone board (ui)' }],
  })
  await expect(call(host, 'launch', { id: 1, size: 'assess' })).rejects.toThrow('already #40')
  expect((await tx.doc(Ideas, 1 as never)).items[0].launch).toMatchObject({
    size: 'assess',
    branch: 40,
  })
})
