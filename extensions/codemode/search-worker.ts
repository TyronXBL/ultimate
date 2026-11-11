// The worker thread behind `searchChapter` (#199903): one search, then it exits.
import { parentPort, workerData } from 'node:worker_threads'
import { searchDatabase } from './search.ts'
import type { SearchRequest } from './search.ts'

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port takes no origin.
parentPort!.postMessage(searchDatabase(workerData as SearchRequest))
