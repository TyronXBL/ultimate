/** Side chats for other extensions' browser code: opening one on @ultimate, its index, and which one is in front. */
import type { ReactNode } from 'react'
import { definePoint, useUiState } from '@/sdk'
import type { ComposerTarget } from '@/sdk'

export { OpenAction, SideChatsDoc } from './refs.ts'

/** The side chat in front of main, by id; durable UI state, so a reload brings the depth view back. */
export const useSideChatFront = () => useUiState<number | null>('ext.side-chat.front', null)

/**
 * Another mode of @ultimate's composer, beside the side chat switch: its `control` in the row above the composer, and
 * while `target` is set, where Enter sends. Side chat on wins over it; `normal` turns side chat off, for a mode the user
 * just armed.
 */
export const ComposerMode = definePoint<
  { side: boolean; normal: () => void },
  { control: ReactNode; target?: ComposerTarget } | undefined
>('side-chat.composer-mode')
