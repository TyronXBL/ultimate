import { describe, expect, it } from 'vitest'
import { describeSchedule, nextAt, parseSchedule } from '../extensions/automations/schedule.ts'

const time = Date.parse('2026-01-05T08:00:00Z')
const next = (expr: string, tz = 'UTC') =>
  new Date(nextAt(parseSchedule(`cron "${expr}" ${tz}`), time)).toISOString()
describe('automation schedules', () => {
  it('matches fields, lists, ranges, steps, Sunday 7 and timezones', () => {
    expect(next('30 9 5 1 *')).toBe('2026-01-05T09:30:00.000Z')
    expect(next('5,10 8-10 * * 1-5')).toBe('2026-01-05T08:05:00.000Z')
    expect(next('*/15 * * * *')).toBe('2026-01-05T08:15:00.000Z')
    expect(next('10-30/10 * * * *')).toBe('2026-01-05T08:10:00.000Z')
    expect(next('0 9 * * 7')).toBe('2026-01-11T09:00:00.000Z')
    expect(next('0 10 * * 1-5', 'Europe/Vienna')).toBe('2026-01-05T09:00:00.000Z')
    expect(next('0 8 * * *')).toBe('2026-01-06T08:00:00.000Z')
    expect(next('0 9 10 * 1')).toBe('2026-01-05T09:00:00.000Z')
    expect(next('0 9 */2 * *')).toBe('2026-01-05T09:00:00.000Z')
    expect(next('0 9 */3 * *')).toBe('2026-01-07T09:00:00.000Z')
    expect(next('* * * * *')).toBe('2026-01-05T08:01:00.000Z')
    expect(next('0 7 * * 1')).toBe('2026-01-12T07:00:00.000Z')
    expect(next('0 9 * * 4')).toBe('2026-01-08T09:00:00.000Z')
    expect(next('0 9 * * 6')).toBe('2026-01-10T09:00:00.000Z')
  })
  it('needs both a restricted date and weekday only when the other starts with *', () => {
    expect(next('0 7 10 * 1')).toBe('2026-01-10T07:00:00.000Z')
    expect(next('0 7 */2 * 1')).toBe('2026-01-19T07:00:00.000Z')
    expect(next('0 7 10 * */2')).toBe('2026-01-10T07:00:00.000Z')
  })
  it('jumps sparse dates, rejects impossible ones and finds leap days', () => {
    const yearly = parseSchedule('cron "0 0 1 1 *" Europe/Vienna')
    const impossible = parseSchedule('cron "0 0 31 4 *" Europe/Vienna')
    expect(new Date(nextAt(yearly, time)).toISOString()).toBe('2026-12-31T23:00:00.000Z')
    expect(() => nextAt(impossible, time)).toThrow('8 years')
    expect(nextAt(parseSchedule('cron "0 0 29 2 *" UTC'), time)).toBe(
      Date.parse('2028-02-29T00:00:00Z'),
    )
  })
  it('fires once in the repeated hour and skips nonexistent spring minutes', () => {
    const schedule = parseSchedule('cron "30 2 * * *" Europe/Vienna')
    const first = nextAt(schedule, Date.parse('2026-10-24T23:00:00Z'))
    expect(first).toBe(Date.parse('2026-10-25T00:30:00Z'))
    expect(nextAt(schedule, first)).toBe(Date.parse('2026-10-26T01:30:00Z'))
    expect(nextAt(schedule, Date.parse('2026-03-28T23:00:00Z'))).toBe(
      Date.parse('2026-03-30T00:30:00Z'),
    )
  })
  it('parses relative, at and interval schedules and describes them', () => {
    expect(parseSchedule('in 30m', time)).toEqual({ kind: 'at', time: '2026-01-05T08:30:00.000Z' })
    expect(parseSchedule('in 2h', time)).toEqual({ kind: 'at', time: '2026-01-05T10:00:00.000Z' })
    expect(parseSchedule('in 1d', time)).toEqual({ kind: 'at', time: '2026-01-06T08:00:00.000Z' })
    expect(parseSchedule('in 1.5 h', time)).toEqual({
      kind: 'at',
      time: '2026-01-05T09:30:00.000Z',
    })
    const once = parseSchedule('at 2026-12-01T09:00:00Z')
    expect(once).toEqual({ kind: 'at', time: '2026-12-01T09:00:00.000Z' })
    expect(nextAt(once, time)).toBe(Date.parse('2026-12-01T09:00:00Z'))
    expect(parseSchedule('2026-12-01T10:00+01:00')).toEqual(once)
    expect(parseSchedule('every 1s')).toEqual({ kind: 'every', ms: 1000 })
    expect(parseSchedule({ kind: 'every', ms: 60000 })).toEqual({ kind: 'every', ms: 60000 })
    expect(nextAt(parseSchedule('every 2s'), time)).toBe(time + 2000)
    expect(describeSchedule(parseSchedule('every 15m'))).toBe('Every 15 minutes')
    expect(describeSchedule(parseSchedule('every 1h'))).toBe('Every 1 hour')
    expect(describeSchedule(parseSchedule('in 30m', time))).toContain('Once at')
    expect(parseSchedule('cron "* * * * *"').kind).toBe('cron')
  })
  it('describes cron schedules in words', () => {
    for (const [expr, tz, words] of [
      ['30 10 * * 1-5', 'Europe/Vienna', 'At 10:30 on weekdays (Europe/Vienna)'],
      ['5 9 1,15 * 1', 'UTC', 'At 09:05 on month days 1,15 or on weekdays 1 (Sunday=0) (UTC)'],
      ['0 9 1 6 *', 'UTC', 'At 09:00 on month days 1 in months 6 (UTC)'],
      ['* * * * *', 'UTC', 'Every minute (UTC)'],
      ['0 */2 * * *', 'UTC', 'At minutes 0 of hours */2 (UTC)'],
      ['0-30/15 9 * * *', 'UTC', 'At minutes 0-30/15 of hours 9 (UTC)'],
      ['* 9 * * *', 'UTC', 'At minutes * of hours 9 (UTC)'],
      ['30 * * * *', 'UTC', 'At minutes 30 of hours * (UTC)'],
      ['0 9-17 * * *', 'UTC', 'At minutes 0 of hours 9-17 (UTC)'],
    ])
      expect(describeSchedule(parseSchedule(`cron "${expr}" ${tz}`))).toBe(words)
  })
  it('rejects invalid input and impossible cron dates', () => {
    for (const [input, error] of [
      ['every 0.5s', 'Intervals must be at least 1s'],
      ['every nope', 'Use a duration'],
      ['every 30m garbage', 'Use a duration'],
      ['in x30m', 'Use a duration'],
      ['in nope', 'Use a duration'],
      ['at nope', 'Use an ISO time'],
      ['at Dec 1, 2026', 'Use an ISO time'],
      ['cron "60 * * * *"', 'Invalid cron field: 60'],
      ['cron "*/0 * * * *"', 'Invalid cron field: */0'],
      ['cron "1x * * * *"', 'Invalid cron field: 1x'],
      ['cron "x1 * * * *"', 'Invalid cron field: x1'],
      ['cron "0 9 0 * *"', 'Invalid cron field: 0'],
      ['cron "0 9 * * 5-1"', 'Invalid cron field: 5-1'],
      ['cron "0 9 * *"', 'Cron requires five fields'],
      ['cron "* * * * *" Mars', 'Mars'],
      ['cron "0 9 * * *" UTC extra', 'Use cron "0 9 * * 1-5" Europe/Vienna'],
      ['0 9 * * 1 Europe/Berlin', 'Use cron "0 9 * * 1" Europe/Berlin'],
      ['30 10 */2 1-6 1-5 Europe/Berlin', 'Use cron "30 10 */2 1-6 1-5" Europe/Berlin'],
      ['0 9 * * 1', /^Use cron "0 9 \* \* 1"$/],
    ] as const)
      expect(() => parseSchedule(input)).toThrow(error)
    expect(() => parseSchedule({ kind: 'every', ms: 500 })).toThrow('at least 1s')
    expect(() => nextAt(parseSchedule('cron "0 9 31 2 *" UTC'), time)).toThrow('8 years')
  })
})
