/** Whether a to-do is ticked, for the server and the panel. Browser-safe. */
import type { Todo } from './refs.ts'

/** The one reading of `done`, which only the server's `mark` writes. */
export const isDone = (todo: Todo): todo is Todo & { done: number } => todo.done !== undefined
