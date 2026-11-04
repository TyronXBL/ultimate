/**
 * What a conversation is doing right now, the one rule every view says it by. Browser-safe.
 * - `paused`: a pause of the host parked its run: nothing of it executes until Play;
 * - `working`: it runs: a foreground task of it, or a model run;
 * - `queued`: input waits in its inbox and nothing runs yet;
 * - `idle`: none of these.
 */
export type Activity = 'paused' | 'working' | 'queued' | 'idle'

/**
 * A conversation's activity from what a view knows of it: `task` a foreground task in the task graph, `run` a model
 * run (`pi.live`), `queued` input in its inbox that is no write, `parked` a pause holding it. Leave out what a view
 * cannot see.
 */
export function activityOf(facts: {
  task?: boolean
  run?: boolean
  queued?: boolean
  parked?: boolean
}): Activity {
  if (facts.parked) return 'paused'
  if (facts.task || facts.run) return 'working'
  return facts.queued ? 'queued' : 'idle'
}

/** Whether work of it is under way that needs no one to act: it runs, waits to run, or a pause holds it. */
export const isBusy = (activity: Activity) => activity !== 'idle'
