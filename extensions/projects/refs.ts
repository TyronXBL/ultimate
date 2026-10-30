/** Projects in the browser: every Ultimate project on this machine and the user's remotes, for the title bar's switcher. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** A project on this machine: one opened before (it has a home in `~/.ultimate/projects`), or this one. */
export type LocalProject = {
  name: string
  /** Its folder; absent for a home whose `project.json` is missing. */
  root?: string
  /** This server's project. */
  current: boolean
  /** Its loopback URL while its supervisor runs. */
  url?: string
  /** Its Tailscale Serve address while it runs and publishes itself there. */
  tailnet?: string
  /** When anyone last wrote to one of its top-level conversations, ms since epoch. */
  activeAt?: number
}

/** An instance the user named in the `remotes` user setting: another machine's project at its URL. */
export type RemoteProject = { machine: string; name: string; url: string }

/** No arguments → this machine's projects (this one first, then by name) and the user's remotes. */
export const ListAction = actionRef<null, { projects: LocalProject[]; remotes: RemoteProject[] }>(
  'projects',
  'list',
)

/**
 * Starts Ultimate in `root`, an absolute folder (`~/` is the user's home), and resolves once it runs: a project opened
 * before or a new one. Resolves at once for a project that already runs; refuses this server's own project. A missing
 * folder resolves `{ missing }` with the path it would create; `create: true` makes it first (`mkdir -p`), never inside
 * this Ultimate's checkout or `~/.ultimate`.
 */
export const StartAction = actionRef<
  { root: string; create?: boolean },
  LocalProject | { missing: string }
>('projects', 'start')
