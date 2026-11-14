const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_OUTPUT_LINES = 2_000
const TRUNCATION_NOTICE = '\n[Output truncated to 50KB / 2000 lines.]'

export function truncateToolOutput(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES)
    return text
  const byteBudget = MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf8')
  const kept: string[] = []
  let bytes = 0
  for (const line of lines.slice(0, MAX_OUTPUT_LINES - 1)) {
    const separatorBytes = kept.length === 0 ? 0 : 1
    const available = byteBudget - bytes - separatorBytes
    if (available <= 0) break
    if (Buffer.byteLength(line, 'utf8') <= available) {
      kept.push(line)
      bytes += separatorBytes + Buffer.byteLength(line, 'utf8')
      continue
    }
    // The longest prefix that fits, by binary search: a UTF-16 unit is at least a byte, so at most `available` units
    // fit. Dropping a character at a time re-measured the whole line each step and blocked the host for minutes on
    // one 5 MiB line, which `web_fetch` can return (#273712).
    let end = 0
    for (let high = Math.min(line.length, available); end < high;) {
      const middle = Math.ceil((end + high) / 2)
      if (Buffer.byteLength(line.slice(0, middle), 'utf8') <= available) end = middle
      else high = middle - 1
    }
    if (end > 0) kept.push(line.slice(0, end))
    break
  }
  return `${kept.join('\n')}${TRUNCATION_NOTICE}`
}
