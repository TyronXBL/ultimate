export const epicStatuses = ['planning', 'in_progress', 'done', 'blocked'] as const
export type EpicStatus = (typeof epicStatuses)[number]
export const taskStatuses = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'canceled',
] as const
export type TaskStatus = (typeof taskStatuses)[number]

export const isEpicStatus = (status: string): status is EpicStatus =>
  epicStatuses.includes(status as EpicStatus)
export const isTaskStatus = (status: string): status is TaskStatus =>
  taskStatuses.includes(status as TaskStatus)
