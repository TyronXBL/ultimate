/**
 * Ideas: the project's idea board on the root conversation. The user collects ideas and launches one, which asks
 * @ultimate to start its branch; @ultimate links the branch with its `idea` tool and adds ideas proposed elsewhere.
 */
import { Type } from '@earendil-works/pi-ai'
import {
  defineDoc,
  defineEntry,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { actingAs } from '../../lib/acting-as.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Standing, SubagentsApi } from '../subagents/api.ts'
import {
  AddAction,
  IdeasDoc,
  LaunchAction,
  ParkAction,
  RemoveAction,
  UpdateAction,
} from './refs.ts'
import type { Idea, LaunchEntry, LaunchSize } from './refs.ts'

const TITLE_CHARS = 120
const NOTES_CHARS = 4000
const TAG_LIMIT = 8
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/
const BREADCRUMB = /^#\d+\/\d+$/

export const Ideas = defineDoc<{ next: number; items: Idea[] }>({
  kind: IdeasDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ next: 1, items: [] }),
})
export const docs = [Ideas]

/** The launch input in @ultimate's conversation; web.tsx renders it as the user's card. */
const LaunchInput = defineEntry<LaunchEntry>('ideas.launch')

function title(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('title must be nonempty')
  const text = value.trim()
  if (text.includes('\n')) throw new Error('title must be one line')
  if (text.length > TITLE_CHARS) throw new Error(`title must be at most ${TITLE_CHARS} characters`)
  return text
}

function notes(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('notes must be text')
  if (value.trim().length > NOTES_CHARS)
    throw new Error(`notes must be at most ${NOTES_CHARS} characters`)
  return value.trim() || undefined
}

function tags(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('tags must be a list')
  const words = [
    ...new Set(
      value.map((tag) => {
        const word = typeof tag === 'string' ? tag.trim().replace(/^#/, '').toLowerCase() : ''
        if (!TAG.test(word))
          throw new Error(`tag ${JSON.stringify(tag)} must be a short word: a-z, 0-9 and -`)
        return word
      }),
    ),
  ]
  if (words.length > TAG_LIMIT) throw new Error(`at most ${TAG_LIMIT} tags`)
  return words
}

const board = (tx: Tx) => tx.doc(Ideas, ROOT_CONVERSATION_ID)

async function find(tx: Tx, id: unknown) {
  const idea = (await board(tx)).items.find((item) => item.id === id)
  if (!idea) throw new Error(`No idea ${String(id)}`)
  return idea
}

// Each returns a copy: the document's overlay is unusable once the commit settles, and callers reply with it.

export async function add(
  tx: Tx,
  input: { title?: unknown; notes?: unknown; tags?: unknown; from?: unknown },
  by: Idea['by'],
) {
  if (input.from !== undefined && (typeof input.from !== 'string' || !BREADCRUMB.test(input.from)))
    throw new Error('from must be a #<conversation>/<entry> breadcrumb')
  const fields = { title: title(input.title), tags: tags(input.tags) }
  const text = notes(input.notes)
  const doc = await board(tx)
  const idea: Idea = { id: doc.next++, ...fields, by, at: Date.now() }
  if (text) idea.notes = text
  if (input.from) idea.from = input.from
  doc.items.push(idea)
  return { ...idea }
}

async function update(
  tx: Tx,
  input: { id?: unknown; title?: unknown; notes?: unknown; tags?: unknown },
) {
  const idea = await find(tx, input.id)
  if (input.title !== undefined) idea.title = title(input.title)
  if (input.tags !== undefined) idea.tags = tags(input.tags)
  if (input.notes !== undefined) {
    const text = notes(input.notes)
    if (text) idea.notes = text
    else delete idea.notes
  }
  return { ...idea }
}

async function park(tx: Tx, id: unknown, parked: unknown) {
  if (typeof parked !== 'boolean') throw new Error('parked must be true or false')
  const idea = await find(tx, id)
  if (parked) idea.parked ??= Date.now()
  else delete idea.parked
  return { ...idea }
}

async function remove(tx: Tx, id: unknown) {
  const idea = await find(tx, id)
  if (idea.launch) throw new Error(`Idea ${idea.id} was launched: park it instead`)
  const doc = await board(tx)
  doc.items = doc.items.filter((item) => item !== idea)
  return { id: idea.id }
}

/**
 * Mark idea `id` launched. Launching again before @ultimate linked a branch keeps the first launch, so its input
 * (keyed by that launch) is placed at most once.
 */
export async function launch(tx: Tx, id: unknown, size: unknown) {
  if (size !== 'assess' && size !== 'build') throw new Error("size must be 'assess' or 'build'")
  const idea = await find(tx, id)
  if (idea.parked !== undefined) throw new Error(`Idea ${idea.id} is parked`)
  if (idea.launch?.branch !== undefined)
    throw new Error(`Idea ${idea.id} is already #${idea.launch.branch}`)
  idea.launch ??= { size: size, at: Date.now() }
  return { ...idea, launch: { ...idea.launch } }
}

export async function link(tx: Tx, id: unknown, branch: unknown) {
  if (typeof branch !== 'number' || !Number.isSafeInteger(branch) || branch < 1)
    throw new Error('branch must be a conversation id')
  const idea = await find(tx, id)
  if (!idea.launch) throw new Error(`Idea ${idea.id} was not launched`)
  idea.launch.branch = branch
  delete idea.parked
  return { ...idea, launch: { ...idea.launch } }
}

const SIZES: Record<LaunchSize, string> = {
  assess: 'feature. Assess first and build nothing.',
  build: 'build: the user asked to build it without an assessment.',
}

/** What @ultimate reads when the user launches an idea. */
export function launchText(idea: Idea & { launch: NonNullable<Idea['launch']> }) {
  return [
    `The user launched idea #${idea.id} from the idea board: start a branch for it.`,
    `Size: ${SIZES[idea.launch.size]}`,
    `Title: ${idea.title}`,
    ...(idea.tags.length ? [`Tags: ${idea.tags.join(', ')}`] : []),
    ...(idea.from ? [`Found in: ${idea.from}`] : []),
    ...(idea.notes ? ['Notes:', idea.notes] : []),
    '',
    `Start it with \`branch\` (its title from the idea, a self-contained prompt with the notes), then call \`idea {action: 'link', id: ${idea.id}, branch: <branch id>}\`.`,
  ].join('\n')
}

const stage = (idea: Idea) =>
  idea.parked !== undefined
    ? 'parked'
    : idea.launch?.branch !== undefined
      ? `#${idea.launch.branch}`
      : idea.launch
        ? 'launching'
        : 'idea'

/** The board as model text, one line per idea; undefined when it is empty. */
export function listText(items: readonly Idea[]) {
  if (!items.length) return undefined
  return items
    .map(
      (idea) =>
        `- ${idea.id} [${stage(idea)}] ${idea.title}${idea.tags.length ? ` (${idea.tags.join(', ')})` : ''}`,
    )
    .join('\n')
}

const field = (args: unknown) =>
  (args && typeof args === 'object' ? args : {}) as Record<string, unknown>

export const userActions = ['add', 'update', 'park', 'remove', 'launch']
export const actions = {
  add: implementAction(AddAction, (args, { host }) =>
    host.harness().commit((tx) => add(tx, field(args), 'user'), context),
  ),
  update: implementAction(UpdateAction, (args, { host }) =>
    host.harness().commit((tx) => update(tx, field(args)), context),
  ),
  park: implementAction(ParkAction, (args, { host }) =>
    host.harness().commit((tx) => park(tx, field(args).id, field(args).parked), context),
  ),
  remove: implementAction(RemoveAction, (args, { host }) =>
    host.harness().commit((tx) => remove(tx, field(args).id), context),
  ),
  launch: implementAction(LaunchAction, async (args, { host }) => {
    const ultimate = await host.need(SubagentsApi).standing('ultimate', context)
    const idea = await host
      .harness()
      .commit((tx) => launch(tx, field(args).id, field(args).size), context)
    const requestId = `ideas.launch:${idea.id}:${idea.launch.at}`
    const placed = await host
      .harness()
      .commit((tx) => tx.submissionByRequest(ultimate, requestId), context)
    if (!placed)
      await (await host.harness().conversation(ultimate, context))!.submit(
        {
          type: 'input',
          content: launchText(idea),
          // The user's request, like a to-do's ▶: after @ultimate's current run, never interrupting it.
          whenBusy: 'followUp',
          requestId,
          entry: {
            kind: LaunchInput.kind,
            data: { id: idea.id, title: idea.title, size: idea.launch.size },
          },
        },
        context,
      )
    return idea
  }),
}

const standing = (tx: Tx, id: ConversationId) =>
  tx.doc(Standing, ROOT_CONVERSATION_ID).then((doc) => doc.ultimate === id)

export default function ideasExtension(host: ExtensionHost) {
  return defineExtension({
    name: 'ideas',
    tools: [
      defineTool({
        name: 'idea',
        deferred: true,
        description:
          "The user's idea board: add {title, notes?, tags?, from?} an idea a branch, dream or survey proposed for later (from: its #<conversation>/<entry>); link {id, branch} the branch you started for a launched idea; list. Ideas are the user's backlog of work to launch, not open loops: those are to-dos.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal('add'), Type.Literal('link'), Type.Literal('list')]),
          title: Type.Optional(Type.String()),
          notes: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Array(Type.String())),
          from: Type.Optional(Type.String()),
          id: Type.Optional(Type.Integer({ minimum: 1 })),
          branch: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        // Not replay-safe (the default): an interrupted add is never rerun, so it commits at most once.
        async execute(args, api, ctx) {
          // A side chat keeps @ultimate's board as main.
          const caller = await actingAs(host, api.conversationId, ctx)
          const text = await api.commit(async (tx) => {
            // Deferred only hides it: a branch can still find it with tool_search, so the caller is checked here.
            if (!(await standing(tx, caller)))
              throw new Error(
                'Only @ultimate keeps the idea board; ask @ultimate to add one (message, reply: false).',
              )
            if (args.action === 'add') {
              const idea = await add(tx, args, 'ultimate')
              return `Added idea ${idea.id}: ${idea.title}`
            }
            if (args.action === 'link') {
              const idea = await link(tx, args.id, args.branch)
              return `Linked idea ${idea.id} to #${idea.launch.branch}`
            }
            return listText((await board(tx)).items) ?? 'The idea board is empty.'
          }, ctx)
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
