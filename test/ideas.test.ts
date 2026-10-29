import type { Task, Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import ideasExtension, { actions, Ideas } from '../extensions/ideas/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const ULTIMATE = 5

/**
 * A host over plain documents whose @ultimate is conversation 5. It records the tasks a commit creates, and what
 * running them submits.
 */
function fakeHost() {
  const docs = new Map<string, object>()
  const tasks: { task: Task<unknown, { phase: string }, unknown, object>; input: unknown }[] = []
  const entries: { id: number; conversation: number; kind: string; data: unknown }[] = []
  const submitted: {
    requestId: string
    whenBusy: string
    content: { type: string; text?: string; data?: string }[]
    entry: unknown
  }[] = []
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
    conversation: async (id: number) => ({ id }),
    createTask: async (task: (typeof tasks)[number]['task'], input: unknown) =>
      void tasks.push({ task, input }),
    appendEntry: async (
      token: { kind: string },
      conversation: number,
      { data }: { data: unknown },
    ) => {
      entries.push({ id: entries.length + 100, conversation, kind: token.kind, data })
      return entries.at(-1)
    },
    entry: async (token: { kind: string }, id: number) =>
      entries.find((entry) => entry.id === id && entry.kind === token.kind),
  } as unknown as Tx
  const runtime = {
    commit: (fn: (tx: Tx) => unknown) => fn(tx),
    conversation: async () => ({
      submit: async (input: (typeof submitted)[number]) => void submitted.push(input),
    }),
  }
  const host = {
    doc: () => undefined,
    need: () => ({ standing: async () => ULTIMATE }),
    harness: () => runtime,
  } as unknown as ExtensionHost
  /** Run every task created so far once, as the harness would after their commits. */
  const runTasks = async () => {
    for (const { task, input } of tasks.splice(0))
      for (const phase of Object.values(task.definition.phases))
        await phase({ input } as never, runtime as never, undefined as never)
  }
  return { host, tx, submitted, entries, runTasks }
}

const call = (host: ExtensionHost, action: keyof typeof actions, args: object) =>
  actions[action](args as never, { host } as never)

it('launches an idea into one input for @ultimate, which links the branch it started', async () => {
  const { host, tx, submitted, entries, runTasks } = fakeHost()
  const picture = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  const idea = await call(host, 'add', {
    title: ' Phone board ',
    notes: 'Stage pills',
    tags: ['#UI'],
    images: [picture],
  })
  expect(idea).toMatchObject({ id: 1, title: 'Phone board', tags: ['ui'], by: 'user', images: 100 })
  // Its pictures live in a display-only entry on conversation 1, not in the board document.
  expect(entries).toEqual([
    {
      id: 100,
      conversation: 1,
      kind: 'ideas.images',
      data: { idea: 1, images: [picture] },
    },
  ])

  await call(host, 'launch', { id: 1, size: 'assess' })
  // A second click before @ultimate linked a branch delivers the first launch again, under the same request id,
  // which admission keeps to one input.
  await call(host, 'launch', { id: 1, size: 'build' })
  await runTasks()
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toEqual(submitted[0])
  expect(submitted[0]).toMatchObject({
    whenBusy: 'followUp',
    entry: { kind: 'ideas.launch', data: { id: 1, title: 'Phone board', size: 'assess' } },
  })
  const [text, image] = submitted[0].content
  expect(text.text).toContain('Assess first and build nothing.')
  expect(text.text).toContain("images: 'latest'")
  expect(text.text).toContain("idea {action: 'link', id: 1, branch: <branch id>}")
  expect(image).toEqual({ type: 'image', ...picture })

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
