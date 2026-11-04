/** Whether a to-do is ticked, for the todos server and panel and for dream's seed. Browser-safe. */

/** The one reading of a to-do's `done`, which only the todos server's `mark` writes. */
export const isDone = <T extends { done?: number }>(todo: T): todo is T & { done: number } =>
  todo.done !== undefined
