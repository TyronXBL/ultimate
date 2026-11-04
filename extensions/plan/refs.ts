/**
 * The plan in the browser: a coordinator's epics and tasks, and the root's index of which child conversation works
 * on which task. Browser-safe.
 */
import { docRef } from '../../shared/extension-api.ts'
import type { EpicStatus, TaskStatus } from './types.ts'
export type { EpicStatus, TaskStatus } from './types.ts'

/** One task of an epic; `child` is the conversation working on it. */
export type Task = {
  key: string
  title: string
  role: string
  description: string
  deps: string[]
  status: TaskStatus
  child?: number
  verdict?: string
  notes: { at: string; text: string }[]
}
/** One epic with its tasks by key. */
export type Epic = {
  key: string
  title: string
  body: string
  status: EpicStatus
  verdict?: string
  tasks: Record<string, Task>
}
/** A coordinator's plan. */
export type Plan = { next: number; epics: Record<string, Epic> }
/** The plan task a child conversation works on, and whose plan it is in. */
export type TaskLink = {
  coordinator: number
  epic: string
  key: string
  title: string
  status: TaskStatus
}

/** A coordinator's epics and tasks, on the coordinator's conversation. */
export const PlanDoc = docRef<Plan>('ultimate.plan')
/** `{ children: { [conversationId]: TaskLink } }` on conversation 1: every linked child's plan task. */
export const TaskIndexDoc = docRef<{ children: Record<string, TaskLink> }>('ultimate.plan.tasks')
