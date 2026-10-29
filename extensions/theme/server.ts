/**
 * Theme: this machine's theme choice lives in `theme` of `~/.ultimate/settings.json`, so every project on the machine
 * shares it. The facet mirrors it into a document on conversation 1, which every browser of this server streams: a
 * choice made on one device repaints the others at once. A hand edit, or another project's server writing the file,
 * reaches the document through a watch on the settings folder.
 */
import { watch } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
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

type ThemeHost = Pick<ExtensionHost, 'userHome' | 'harness' | 'notice'>

/** Put `choice` into the document unless it already holds it. */
async function store(host: ThemeHost, choice: ThemeChoice) {
  const same = (doc: { choice?: ThemeChoice } | undefined) =>
    JSON.stringify(doc?.choice ?? DEFAULT_CHOICE) === JSON.stringify(choice)
  if (same(await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context))) return
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (!same(doc)) doc.choice = choice
  }, context)
}

/** Mirror the settings file's `theme` into the document; an invalid one is reported and counts as the default. */
async function mirror(host: ThemeHost) {
  const { theme } = await readSettings(userSettingsPath(host.userHome))
  const choice = theme === undefined ? DEFAULT_CHOICE : parseChoice(theme)
  if (!choice)
    host.notice(
      `Invalid theme ${JSON.stringify(theme)} in ~/.ultimate/settings.json; using the default`,
    )
  await store(host, choice ?? DEFAULT_CHOICE)
}

export const actions = {
  /** `ThemeChoice` → the saved choice: written to the user's settings, then mirrored into the document. */
  set: implementAction(SetAction, async (args, { host }) => {
    const choice = parseChoice(args)
    if (!choice) throw new Error(`Not a theme choice: ${JSON.stringify(args)}`)
    await updateSettings(userSettingsPath(host.userHome), (settings) => {
      settings.theme = choice
    })
    await store(host, choice)
    return choice
  }),
}

export default function themeExtension(host: ExtensionHost) {
  const file = userSettingsPath(host.userHome)
  const report = (error: unknown) => host.notice(`Theme settings: ${String(error)}`)
  let watcher: ReturnType<typeof watch> | undefined
  host.onOpen(async () => {
    await mirror(host).catch(report)
    // The folder, not the file: the settings file is replaced on save and may not exist yet.
    await mkdir(dirname(file), { recursive: true })
    watcher = watch(dirname(file), (_event, name) => {
      if (name === basename(file)) void mirror(host).catch(report)
    })
  })
  host.onClose(async () => watcher?.close())
  return defineExtension({ name: 'theme' })
}
