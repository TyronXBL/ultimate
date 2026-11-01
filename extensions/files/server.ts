import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { LocateAction, ReadAction, ScopesAction, TreeAction } from './refs.ts'
import { locate, read, tree } from './files.ts'
import type { Source } from './files.ts'

/** A scope with where its files come from, which never leaves the server. */
type Scope = Source & {
  branch: string
  conversation?: number
  title?: string
  concluded?: number
}

/**
 * The project checkout first, then every ready worktree, newest first, then every released one whose branch has not
 * landed, read from that branch's last commit, most recently committed first.
 */
async function scopes(host: ExtensionHost): Promise<Scope[]> {
  const doc = host.need(WorkspacesApi).doc
  const state = await host.harness().snapshot(doc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
  const items = Object.entries(state?.items ?? {})
  const worktrees = items
    .filter(([, item]) => item.state === 'ready')
    .toSorted(([a], [b]) => Number(b) - Number(a))
  const titles = new Map(host.conversations().map((item) => [item.id, item.title]))
  const removed = items.filter(([, item]) => item.state === 'removed')
  // Branches with commits the checkout's branch lacks, by name, with their last commit's time. Asked only when a
  // worktree was released: before the first commit there is no HEAD to compare with.
  const unlanded = new Map(
    (removed.length === 0
      ? ''
      : await git(
          host.projectRoot,
          'for-each-ref',
          '--no-merged=HEAD',
          '--format=%(committerdate:unix) %(refname)',
          'refs/heads/',
        )
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ')
        return [
          line.slice(space + 1).replace(/^refs\/heads\//, ''),
          Number(line.slice(0, space)) * 1000,
        ]
      }),
  )
  const released = removed
    .filter(([, item]) => unlanded.has(item.branch))
    .map(([id, item]) => ({
      root: item.path,
      repo: host.projectRoot,
      rev: `refs/heads/${item.branch}`,
      branch: item.branch,
      conversation: Number(id),
      title: titles.get(Number(id)),
      concluded: unlanded.get(item.branch)!,
    }))
    .toSorted((a, b) => b.concluded - a.concluded)
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
    ...released,
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
  if (!scope) throw new Error(`No worktree or unlanded branch for conversation #${conversation}`)
  return scope
}

export const actions = {
  scopes: implementAction(ScopesAction, async (_args, { host }) =>
    (await scopes(host)).map(({ root: _root, repo: _repo, rev: _rev, ...scope }) => scope),
  ),
  tree: implementAction(TreeAction, async (args, { host }) => ({
    files: await tree(await selected(host, input(args).conversation)),
  })),
  read: implementAction(ReadAction, async (args, { host }) => {
    const value = input(args)
    if (typeof value.path !== 'string') throw new Error('Expected { path }')
    return read(await selected(host, value.conversation), value.path)
  }),
  locate: implementAction(LocateAction, async (args, { host }) => {
    const value = input(args)
    if (typeof value.path !== 'string') throw new Error('Expected { path }')
    const all = await scopes(host)
    // The writing conversation's own worktree (or, released, its branch) first, then the checkout and the other live
    // worktrees in order; other branches' commits are not where a path written elsewhere points.
    const own = all.find((item) => item.conversation === value.conversation)
    const live = all.filter((item) => item !== own && !item.rev)
    for (const scope of own ? [own, ...live] : live) {
      const found = await locate(scope, value.path)
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
