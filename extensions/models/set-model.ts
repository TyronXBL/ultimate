/** The one writer of a conversation's model and of `models.owner`, who set it: `ModelsApi.setModel`. */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc, configure, defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ModelOwnerDoc } from './refs.ts'
import type { ModelOwner } from './refs.ts'
import { ownerStep } from './owner.ts'
import type { ModelEvent } from './owner.ts'

/** A conversation without the document, also one from before it, started on the model it runs: `default`. */
export const Owner = defineDoc<ModelOwner>({
  kind: ModelOwnerDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  // As `pi.agent`: a fork at an older entry inherits the owner of the model it inherits.
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ by: 'default' }),
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
  const next = JSON.stringify(ownerStep(owner, event))
  if (next !== JSON.stringify(owner)) {
    for (const key of Object.keys(owner)) Reflect.deleteProperty(owner, key)
    Object.assign(owner, JSON.parse(next))
  }
  if (event.type === 'login-wait') return
  if (event.type === 'pick') {
    await configure(tx, id, { model: event.model, thinkingLevel: event.thinkingLevel })
    return
  }
  const agent = await tx.doc(AgentDoc, id)
  agent.model = { provider: event.to.provider, modelId: event.to.modelId }
  const model = host.modelRuntime.getModel(event.to.provider, event.to.modelId)
  if (model && agent.thinkingLevel)
    agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
}
