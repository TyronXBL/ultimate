/** A branch's own agent setup, picked in @ultimate's composer before the branch starts. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** `{ [definition]: 'provider/id[:thinking]' }`: the model and thinking level each named agent runs on in a branch. */
export type Agents = Record<string, string>

/** The `branch.setup` input in @ultimate's conversation: the user's request with the setup its branch runs on. */
export type SetupEntry = { text: string; agents: Agents }

/**
 * User only: `{ id, text, agents }` → `{ conversation }`: one `branch.setup` input into @ultimate's conversation, which
 * asks it to start one branch for `text` with `agents`; `id` keys it, so a retry places nothing new. Throws on an
 * agent that is not a definition, a standing agent, or a model without a login here.
 */
export const StartAction = actionRef<
  { id: string; text: string; agents: Agents },
  { conversation: number }
>('branch-setup', 'start')
/** No arguments → `{ presets }`: the user's saved setups by name, from `branchPresets` in ~/.ultimate/settings.json. */
export const PresetsAction = actionRef<null, { presets: Record<string, Agents> }>(
  'branch-setup',
  'presets',
)
/** User only: `{ name, agents }` → `{ presets }`: save (or replace) preset `name`. */
export const SavePresetAction = actionRef<
  { name: string; agents: Agents },
  { presets: Record<string, Agents> }
>('branch-setup', 'savePreset')
/** User only: `{ name }` → `{ presets }`: delete preset `name`. */
export const DeletePresetAction = actionRef<{ name: string }, { presets: Record<string, Agents> }>(
  'branch-setup',
  'deletePreset',
)
