import { createContext, useContext } from 'react'

/** The thread a transcript inside it shows alone (`ThreadView`); cards there show open, not folded. */
export const ThreadContext = createContext<number | undefined>(undefined)

/** The thread the transcript around the caller shows alone, `undefined` outside a `ThreadView`. */
export const useThread = () => useContext(ThreadContext)
