/**
 * Models in the browser: provider login flows, which a conversation's login dialog follows, and the actions that
 * start, answer and cancel them or log out, and the event of a completed login or logout. Browser-safe.
 */
import type { AuthEvent, AuthPrompt, AuthType, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** Where a login flow stands; only `transition` (login-state.ts) changes it. */
export type LoginPhase<Prompt = AuthPrompt> =
  /** `prompt`: the one waiting for an answer, without its `signal`. */
  | { state: 'running'; prompt?: Prompt }
  | { state: 'complete' }
  | { state: 'cancelled' }
  | { state: 'failed'; error: string }

/** One login flow as the browser sees it. Answers and credentials never enter it. */
export type LoginFlow = {
  provider: string
  type: AuthType
  phase: LoginPhase
  events: AuthEvent[]
}

/** The login flows started from a conversation, by flow id, on that conversation; finished ones are kept for a while. */
export const LoginDoc = docRef<{ flows: Record<string, LoginFlow> }>('models.login')

/** `{ provider, type }` → `{ flowId }`: start logging in to `provider` for the calling conversation. */
export const LoginAction = actionRef<{ provider: string; type: AuthType }, { flowId: string }>(
  'models',
  'login',
)
/** `{ flowId, value }` → null: answer the flow's pending prompt; an empty answer is allowed. */
export const AnswerAction = actionRef<{ flowId: string; value: string }, null>('models', 'answer')
/** `{ flowId }` → null: cancel a running login flow. */
export const CancelAction = actionRef<{ flowId: string }, null>('models', 'cancel')
/** `{ provider }` → null: remove the provider's stored credential, which Pi shares. */
export const LogoutAction = actionRef<{ provider: string }, null>('models', 'logout')

/**
 * A `models.fallback` entry: the conversation's model (`provider/id`) had no login here, so its next run switched to
 * `to`: the same model on another provider, its definition's pin or the default model. Without `to` nothing could
 * replace it (or only a pay-per-token login could replace a subscription), so it kept its model and needs the user.
 */
export type Fallback = { from: string; to?: string; reason: SwitchReason | 'none' }
/** What a switch off a model without a login took: the same model elsewhere, the definition's pin or the default. */
export type SwitchReason = 'same' | 'pin' | 'default'

/**
 * `models.owner`, on that conversation: who set its model. `default` it started on (also every conversation from
 * before this record), `user` picked it, `login-fallback` switched off `from` (`provider/modelId`), which had no login
 * here, for `reason`; `login-wait` kept `from` without a login and asked the user once, over the owner it found
 * (`under`), so the way back to it survives the wait; `backup` temporarily runs on a backup model and keeps the
 * original owner underneath. Only `ownerStep` (owner.ts) decides it. `default` also covers a model its creator set:
 * a subagent's definition or caller, a standing agent's pin, a branch's given model.
 */
export type ModelOwner =
  | OwnerBeforeWait
  | { by: 'login-wait'; from: string; under: OwnerBeforeWait }
type OwnerBeforeWait =
  | OwnerBeforeBackup
  | ({ by: 'backup' } & BackupRecord & { under: OwnerBeforeBackup })
type OwnerBeforeBackup =
  | { by: 'default' }
  | { by: 'user' }
  | { by: 'login-fallback'; from: string; reason: SwitchReason }
/**
 * One switch away from the primary after a limit, so the next limit can switch again from there: the model and thinking
 * level the conversation runs on otherwise, the backup it runs on now and since when (ms), the models it already left
 * (`provider/modelId`, the last the one whose limit moved it), so a chain of limits tries each backup once, and the
 * limit that moved it (`rate limit`, `quota`).
 */
export type BackupRecord = {
  primary: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  to: { provider: string; modelId: string }
  since: number
  tried: string[]
  reason: string
}
/** Who set the conversation's model, on that conversation; a conversation without it reads `default`. */
export const ModelOwnerDoc = docRef<ModelOwner>('models.owner')

/** A conversation on a backup as its row shows it: the model that hit the limit, the backup's id and the limit. */
export type BackupShown = { from: string; model: string; reason: string }
/**
 * `{ [conversationId]: BackupShown }` of the conversations that run on a backup, on conversation 1, so rows read one
 * document; `ModelsApi.setModel` keeps it with the owner. A fork that inherits a backup has none until its next switch.
 */
export const BackupsDoc = docRef<Record<string, BackupShown>>('models.backups')

/**
 * `{ provider, modelId, thinkingLevel? }` → null: the user picks the calling conversation's model; the level must suit
 * the model, and without one the current level is clamped to it.
 */
export const PickAction = actionRef<
  { provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel },
  null
>('models', 'pick')

/**
 * A login or logout of model provider `provider` completed through Ultimate; react to it to drop what you knew about
 * that provider's credentials (health resets its record to unknown).
 */
export const LoginChanged = defineEvent<{ provider: string }>('models.login-changed')

/** One model family as the Agents panel shows it. */
export type FamilyView = {
  name: string
  color: string
  /** `provider/id`; unset for a default family that follows Pi's default model (`follows`). */
  model?: string
  thinking?: ModelThinkingLevel
  /** Pi's default model and thinking, which a default family without its own runs. */
  follows?: string
  followsThinking?: ModelThinkingLevel
  builtin: boolean
  /** The project's settings set something of it, over the user's. */
  project?: true
}

/** Something that calls a model: an agent definition (`agent/<name>`) or a feature (`summaries`, `preview`). */
export type FamilyUser = {
  id: string
  kind: 'agent' | 'feature'
  label: string
  description: string
  /** The family it runs on; undefined while a model is pinned (`pinned`). */
  family?: string
  /** The family its definition names, or the feature's default. */
  natural: string
  /** A model it pins (`provider/id`, or `off`), and where: a definition file or a settings key. */
  pinned?: string
  pinnedIn?: string
  /** A feature the project's settings assign or pin, so the user's choice does not apply. */
  project?: true
  source?: 'builtin' | 'user' | 'project'
}

export type FamiliesView = {
  /** In display order: built-ins, then the user's. */
  families: FamilyView[]
  users: FamilyUser[]
  /** The saved feature assignments; the project's team settings may add more. */
  assign: Record<string, string>
  /** Whose families these are: this project's own, the most recently saved ones, or the built-in ones. */
  from: 'project' | 'recent' | 'builtin'
  /** Settings problems: a `modelFamilies` layer that fails to parse counts as empty. */
  errors: string[]
}

/** No arguments → the families and who runs on which. */
export const FamiliesAction = actionRef<null, FamiliesView>('models', 'families')

export type SaveFamilies = {
  families: Record<string, { model?: string; thinking?: ModelThinkingLevel; color: string }>
  /** Which family each feature (`summaries`, `preview`) runs on; agents keep theirs in their definitions. */
  assign: Record<string, string>
  /** Features whose user-settings pin (`summaryModel`, `instance.model`) a family replaces. */
  unpin: string[]
}
/**
 * Save this project's families, also as the most recent ones new projects start from. Conversations started after it
 * use them; open ones keep their model.
 */
export const SaveFamiliesAction = actionRef<SaveFamilies, null>('models', 'saveFamilies')
