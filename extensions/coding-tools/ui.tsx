/** Coding tools for other extensions' browser code. */
import { definePoint } from '@/sdk'

export const OpenFile = definePoint<
  { path: string; line?: number; conversation?: number },
  (() => void) | undefined
>('coding-tools.open-file')

/** The event each commit made through the bash tool records. */
export { Committed } from './refs.ts'
