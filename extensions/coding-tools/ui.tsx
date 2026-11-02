/**
 * Coding tools for other extensions' browser code: the point that opens a file, the event each commit made through
 * the bash tool records, and the diff rows the edit tool shows, for other changes shown as a diff.
 */
import { definePoint } from '@/sdk'

export const OpenFile = definePoint<
  { path: string; line?: number; conversation?: number },
  (() => void) | undefined
>('coding-tools.open-file')

export { Committed } from './refs.ts'
export { Diff, parsePatch } from './diff.tsx'
