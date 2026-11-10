/** The one writer of a conversation's model and of `models.owner`, who set it: `ModelsApi.setModel`. */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc, configure, defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BackupsDoc, ModelOwnerDoc } from './refs.ts'
import type { BackupShown, ModelOwner } from './refs.ts'
import { backupIn, limitWaitIn, ownerStep } from './owner.ts'
import type { ModelEvent } from './owner.ts'
import type { ModelsService } from './api.ts'

/** A conversation without the document, also one from before it, started on the model it runs: `default`. */
export const Owner = defineDoc<ModelOwner>({
  kind: ModelOwnerDoc.kind,
  checkpointWhen: () => false,
  version: 2,
  scope: 'conversation',
  // As `pi.agent`: a fork at an older entry inherits the owner of the model it inherits.
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ by: 'default' }),
  // Version 1 backups recorded no limit; they ran for a few hours of 2026-11-05 only. Can go once none is left.
  migrate: (value) => {
    const found = (value.by === 'login-wait' ? value.under : value) as JsonObject
    if (found.by === 'backup' && found.reason === undefined) found.reason = 'limit'
    return value as ModelOwner
  },
})

/** The conversations on a backup, as their rows show them; only `setModel` writes it, beside the owner. */
export const Backups = defineDoc<Record<string, BackupShown>>({
  kind: BackupsDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** The `ModelsApi` service over this owner. */
export const modelsService = (host: Pick<ExtensionHost, 'modelRuntime'>): ModelsService => ({
  setModel: (tx, id, event) => setModel(host, tx, id, event),
  owner: (tx, id) => tx.doc(Owner, id),
  backup: async (tx, id) => backupIn(await tx.doc(Owner, id)),
  limitWait: async (tx, id) => limitWaitIn(await tx.doc(Owner, id)),
})

/** Set conversation `id`'s model as `event` says, inside `tx`, and record the owner `ownerStep` returns. */
export async function setModel(
  host: Pick<ExtensionHost, 'modelRuntime'>,
  tx: Tx,
  id: ConversationId,
  event: ModelEvent,
) {
  const owner = await tx.doc(Owner, id)
  // A plain copy: the new owner may hold parts of the stored one (a wait's `under`), which is emptied below.
  const found = backupIn(owner)
  const backup = found && { primary: { ...found.primary }, thinking: found.thinking }
  const step = ownerStep(owner, event)
  const next = JSON.stringify(step)
  if (next !== JSON.stringify(owner)) {
    for (const key of Object.keys(owner)) Reflect.deleteProperty(owner, key)
    Object.assign(owner, JSON.parse(next))
  }
  const shown = backupIn(step)
  if (found || shown) {
    const backups = await tx.doc(Backups, ROOT_CONVERSATION_ID)
    if (shown)
      backups[String(id)] = {
        from: shown.tried.at(-1) ?? `${shown.primary.provider}/${shown.primary.modelId}`,
        model: shown.to.modelId,
        reason: shown.reason,
      }
    else delete backups[String(id)]
  }
  if (event.type === 'login-wait') return
  if (event.type === 'start') {
    await configure(tx, id, {
      model: event.model,
      ...(event.thinkingLevel === undefined ? {} : { thinkingLevel: event.thinkingLevel }),
    })
    return
  }
  if (event.type === 'pick') {
    await configure(tx, id, { model: event.model, thinkingLevel: event.thinkingLevel })
    return
  }
  const agent = await tx.doc(AgentDoc, id)
  // A wait puts the primary back when it starts, so its end (a return with no backup) changes no model.
  const primary =
    event.type === 'wait' ? event.record : event.type === 'return' ? backup : undefined
  if (event.type === 'return' || event.type === 'wait') {
    if (!primary) return
    agent.model = { provider: primary.primary.provider, modelId: primary.primary.modelId }
    if (primary.thinking) agent.thinkingLevel = primary.thinking
    else delete agent.thinkingLevel
    return
  }
  const ref = event.type === 'backup' ? event.record.to : event.to
  agent.model = ref
  const model = host.modelRuntime.getModel(ref.provider, ref.modelId)
  const level = event.type === 'backup' ? event.level : undefined
  if (level && model) agent.thinkingLevel = clampThinkingLevel(model, level)
  else if (model && agent.thinkingLevel)
    agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
}
