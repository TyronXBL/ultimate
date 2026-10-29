/**
 * Theme: this machine's theme choice lives in `theme` of `~/.ultimate/settings.json`, so every project on the machine
 * shares it. The facet mirrors it into a document on conversation 1, which every browser of this server streams: a
 * choice made on one device repaints the others at once. A hand edit, or another project's server writing the file,
 * reaches the document when the host reloads this facet for the changed settings file.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { DEFAULT_CHOICE, parseChoice } from './palette.ts'
import { SetAction, ThemeDoc } from './refs.ts'
import type { ThemeChoice } from './refs.ts'

const State = defineDoc<{ choice?: ThemeChoice }>({
  kind: ThemeDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]

/** The host reinstalls this facet whenever a settings file changes, and its `onOpen` mirrors the file again. */
export const reloadOnSettings = true

type ThemeHost = Pick<ExtensionHost, 'userHome' | 'harness' | 'notice' | 'resource'>

/**
 * Mirror the settings file's `theme` into the document; an invalid one is reported and counts as the default. Mirrors
 * run one at a time across facet reloads, each reading the file afresh, so the last one leaves the latest choice.
 */
function mirror(host: ThemeHost) {
  const queue = host.resource('theme.mirror', () => ({ last: Promise.resolve() }))
  const run = async () => {
    const { theme } = await readSettings(userSettingsPath(host.userHome))
    let choice = theme === undefined ? DEFAULT_CHOICE : parseChoice(theme)
    if (!choice) {
      host.notice(
        `Invalid theme ${JSON.stringify(theme)} in ~/.ultimate/settings.json; using the default`,
      )
      choice = DEFAULT_CHOICE
    }
    const json = JSON.stringify(choice)
    const same = (doc: { choice?: ThemeChoice } | undefined) =>
      JSON.stringify(doc?.choice ?? DEFAULT_CHOICE) === json
    if (same(await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context))) return
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
      if (!same(doc)) doc.choice = choice
    }, context)
  }
  const next = queue.last.then(run, run)
  queue.last = next.catch(() => {
    // Its caller sees the failure; the queue only orders the next mirror after it.
  })
  return next
}

export const actions = {
  /** `ThemeChoice` → the saved choice: written to the user's settings, then mirrored into the document. */
  set: implementAction(SetAction, async (args, { host }) => {
    const choice = parseChoice(args)
    if (!choice) throw new Error(`Not a theme choice: ${JSON.stringify(args)}`)
    await updateSettings(userSettingsPath(host.userHome), (settings) => {
      settings.theme = choice
    })
    await mirror(host)
    return choice
  }),
}

export default function themeExtension(host: ExtensionHost) {
  host.onOpen(() =>
    mirror(host).catch((error: unknown) => host.notice(`Theme settings: ${String(error)}`)),
  )
  return defineExtension({ name: 'theme' })
}
