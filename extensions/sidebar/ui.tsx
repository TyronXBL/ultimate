/**
 * The sidebar for other extensions' browser code: its points, where a branch stands as its row shows it (in flight or
 * landed, its state word, its work so far) and the roots' landing notes.
 */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

export { inFlight, landedAt, useBranchState, useFlightWork } from './branch.tsx'
export type { BranchTone } from './branch.tsx'
export { useLandings } from './landed.tsx'
export type { Landing } from './landings.ts'

/**
 * Rows nested under @ultimate's row (`side-chat` lists its open side chats, `voice-live` the Voice conversation); several
 * extensions may provide it and their rows show in discovery order. Input is @ultimate's conversation id.
 */
export const UnderUltimate = definePoint<number | undefined, ReactNode>('sidebar.under-ultimate')
/**
 * Top-level conversations no section lists (`side-chat` names its side chats, open or ended, `voice-live` the Voice
 * conversation; both nest under @ultimate instead); several extensions may provide it and the sidebar takes the union.
 * Input is @ultimate's conversation id.
 */
export const Unlisted = definePoint<number | undefined, ReadonlySet<number>>('sidebar.unlisted')
