/**
 * Branch setup: the user picks the model and thinking level of each agent for the next branch in @ultimate's composer.
 * The request goes to @ultimate as a `branch.setup` input; @ultimate starts the branch with `branch({ agents })`, and
 * subagents under it run on the setup (`BranchSetup` in extensions/subagents). Presets live in the user's settings.
 */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineEntry } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { checkSetup } from '../../lib/agents.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UserInputEvent } from '../../shared/events.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { DeletePresetAction, PresetsAction, SavePresetAction, StartAction } from './refs.ts'
import type { Agents, SetupEntry } from './refs.ts'

/** The user's request with its setup, in @ultimate's conversation; web.tsx renders it as the user's card. */
const SetupInput = defineEntry<SetupEntry>('branch.setup')

const NAME_CHARS = 40

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** What @ultimate reads: the user's request, then the setup to pass on. */
const setupText = (text: string, agents: Agents) =>
  [
    text,
    '',
    `The user picked this branch's agent setup in the composer: start one branch for the request above and pass \`agents\` to \`branch\` exactly as given.`,
    `agents: ${JSON.stringify(agents)}`,
  ].join('\n')

/** The saved presets; entries that are not a name → setup map are left out. */
async function presets(host: ExtensionHost) {
  const saved = (await readSettings(userSettingsPath(host.userHome))).branchPresets
  return Object.fromEntries(
    Object.entries(isObject(saved) ? saved : {}).filter(
      (entry): entry is [string, Agents] =>
        isObject(entry[1]) && Object.values(entry[1]).every((model) => typeof model === 'string'),
    ),
  )
}

function presetName(name: unknown) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_CHARS)
    throw new Error(`name must be 1 to ${NAME_CHARS} characters`)
  return name.trim()
}

const updatePresets = async (host: ExtensionHost, change: (saved: JsonObject) => void) => {
  await updateSettings(userSettingsPath(host.userHome), (settings) => {
    const saved = isObject(settings.branchPresets) ? settings.branchPresets : {}
    change(saved)
    settings.branchPresets = saved
  })
  return { presets: await presets(host) }
}

export const userActions = ['start', 'savePreset', 'deletePreset']
export const actions = {
  start: implementAction(StartAction, async (args, { host, device }) => {
    const input = isObject(args) ? args : {}
    if (typeof input.id !== 'string' || !input.id || input.id.length > 100)
      throw new Error('id must be a short string')
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('text is required')
    const agents = await checkSetup(host, input.agents)
    const request = input.text.trim()
    const text = setupText(request, agents)
    const ultimate = await host.need(SubagentsApi).standing('ultimate', context)
    const conversation = (await host.harness().conversation(ultimate, context))!
    const submission = await conversation.submit(
      {
        type: 'input',
        content: [{ type: 'text', text }],
        entry: { kind: SetupInput.kind, data: { text: request, agents } },
        // The user's typed request: it steers a busy @ultimate as their message would.
        whenBusy: 'steer',
        requestId: `branch.setup:${input.id}`,
      },
      context,
    )
    const admitted = await submission.status(context)
    await host.harness().commit(
      (tx) =>
        host.emit(tx, UserInputEvent, {
          conversation: ultimate,
          kind: 'prompt',
          ...(admitted.entry === undefined
            ? { submission: submission.id }
            : { entry: admitted.entry }),
          length: text.length,
          ...device,
        }),
      context,
    )
    return { conversation: ultimate }
  }),
  presets: implementAction(PresetsAction, async (_args, { host }) => ({
    presets: await presets(host),
  })),
  savePreset: implementAction(SavePresetAction, async (args, { host }) => {
    const input = isObject(args) ? args : {}
    const name = presetName(input.name)
    const agents = await checkSetup(host, input.agents)
    return updatePresets(host, (saved) => {
      saved[name] = agents
    })
  }),
  deletePreset: implementAction(DeletePresetAction, async (args, { host }) => {
    const name = presetName(isObject(args) ? args.name : undefined)
    return updatePresets(host, (saved) => {
      delete saved[name]
    })
  }),
}

export default { name: 'branch-setup' }
