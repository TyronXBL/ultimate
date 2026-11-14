import type { RanWhere } from './refs.ts'

/** The line that says where a command ran: on the card and in the result the agent reads. */
export const describeWhere = (where: RanWhere) =>
  where.kind === 'remote'
    ? `Ran on ${where.host}${where.timings ? ` in ${where.timings.runSeconds} s: ${where.timings.cpuSeconds} s of CPU there, after ${where.timings.transferSeconds} s to send the checkout and ${where.timings.setupSeconds} s to set it up` : ''}.`
    : where.kind === 'here'
      ? 'Ran here: the project does not run this command on its remote runner.'
      : `Ran here: ${where.host} gave no result (${where.reason}).`
