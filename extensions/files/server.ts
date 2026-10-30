import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { LocateAction, ReadAction, ScopesAction, TreeAction } from './refs.ts'
import { locate, read, tree } from './files.ts'

/** A scope with its root on disk, which never leaves the server. */
type Scope = { root: string; branch: string; conversation?: number; title?: string }

/** The project checkout first, then every ready worktree, newest first. */
async function scopes(host: ExtensionHost): Promise<Scope[]> {
  const doc = host.need(WorkspacesApi).doc
  const state = await host.harness().snapshot(doc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
  const worktrees = Object.entries(state?.items ?? {})
    .filter(([, item]) => item.state === 'ready')
    .toSorted(([a], [b]) => Number(b) - Number(a))
  const titles = new Map(host.conversations().map((item) => [item.id, item.title]))
  return [
    {
      root: host.projectRoot,
      branch: await git(host.projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'),
    },
    ...worktrees.map(([id, item]) => ({
      root: item.path,
      branch: item.branch,
      conversation: Number(id),
      title: titles.get(Number(id)),
    })),
  ]
}

function input(args: unknown) {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}
async function selected(host: ExtensionHost, conversation: unknown) {
  const all = await scopes(host)
  if (conversation === undefined) return all[0]
  if (typeof conversation !== 'number' || !Number.isSafeInteger(conversation) || conversation < 1)
    throw new Error('conversation must be a conversation id')
  const scope = all.find((item) => item.conversation === conversation)
  if (!scope) throw new Error(`No ready worktree for conversation #${conversation}`)
  return scope
}

export const actions = {
  scopes: implementAction(ScopesAction, async (_args, { host }) =>
    (await scopes(host)).map(({ root: _root, ...scope }) => scope),
  ),
  tree: implementAction(TreeAction, async (args, { host }) => ({
    files: await tree((await selected(host, input(args).conversation)).root),
  })),
  read: implementAction(ReadAction, async (args, { host }) => {
    const value = input(args)
    if (typeof value.path !== 'string') throw new Error('Expected { path }')
    return read((await selected(host, value.conversation)).root, value.path)
  }),
  locate: implementAction(LocateAction, async (args, { host }) => {
    const value = input(args)
    if (typeof value.path !== 'string') throw new Error('Expected { path }')
    const all = await scopes(host)
    // The writing conversation's own worktree first, then the checkout and the other worktrees in order.
    const own = all.find((item) => item.conversation === value.conversation)
    for (const scope of own ? [own, ...all.filter((item) => item !== own)] : all) {
      const found = await locate(scope.root, value.path)
      if (found)
        return {
          ...(scope.conversation !== undefined && { conversation: scope.conversation }),
          path: found,
        }
    }
    return null
  }),
}
export default { name: 'files' }
