/** The backup run's one transition and the one headline every reader uses. Browser-safe, pure. */
import type { LastBackup, Run } from './types.ts'

export type RunEvent =
  | { type: 'begin' }
  | { type: 'progress'; done: number; total: number; uploaded: number }
  | { type: 'succeeded' }
  | { type: 'refused'; error: string; latest?: { id: string; machine: string; at: number } }
  | { type: 'failed'; error: string }
  /** The run stopped before it uploaded (backups off, satellite, no GitHub origin). */
  | { type: 'aborted' }

export const idle: Run = { state: 'idle' }

export function transition(run: Run, event: RunEvent): Run {
  switch (event.type) {
    case 'begin':
      return run.state === 'uploading'
        ? run
        : { state: 'uploading', done: 0, total: 0, uploaded: 0 }
    case 'progress':
      return run.state === 'uploading'
        ? { state: 'uploading', done: event.done, total: event.total, uploaded: event.uploaded }
        : run
    case 'succeeded':
      return idle
    case 'refused':
      return {
        state: 'conflict',
        error: event.error,
        ...(event.latest && { latest: event.latest }),
      }
    case 'failed':
      return { state: 'failed', error: event.error }
    case 'aborted':
      return run.state === 'uploading' ? idle : run
    default:
      return event satisfies never
  }
}

/** What the status line says: the running upload, a refusal, the last backup (`since` words its age), or none yet. */
export function headline(run: Run, last: LastBackup | undefined, since: (at: number) => string) {
  if (run.state === 'uploading') return 'backing up…'
  if (run.state === 'conflict') return 'backup refused'
  return last ? `backed up ${since(last.at)}` : 'no backup yet'
}
