import { api, defineWebExtension, provide } from '@/sdk'
import { ComposerMode } from '../side-chat/ui.tsx'
import { SetupCard, SetupChip } from './card.tsx'
import { StartAction } from './refs.ts'
import { SetupControl } from './sheet.tsx'
import { setSetup, useSetup } from './state.tsx'

/**
 * Beside the side chat switch above @ultimate's composer: the pill and its sheet, and while the next branch has a setup
 * (and side chat is off), Send asks @ultimate to start that branch on it.
 */
function useSetupMode({ side, normal }: { side: boolean; normal: () => void }) {
  const setup = useSetup()
  const armed = Object.keys(setup).length > 0
  return {
    control: <SetupControl normal={normal} side={side} />,
    target:
      armed && !side
        ? {
            placeholder: 'Describe the branch — it starts on your setup…',
            send: async (text: string) => {
              await api.action(StartAction, { id: crypto.randomUUID(), text, agents: setup })
              setSetup({})
            },
          }
        : undefined,
  }
}

export default defineWebExtension({
  entries: { 'branch.setup': SetupCard },
  slots: { 'header.right': [SetupChip] },
  provides: [provide(ComposerMode, useSetupMode)],
})
