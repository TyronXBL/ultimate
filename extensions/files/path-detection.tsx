export function splitLine(value: string) {
  const match = /:(\d+)(?:-\d+)?$/.exec(value)
  return {
    path: match ? value.slice(0, match.index) : value,
    line: match ? Number(match[1]) : undefined,
  }
}

/** Conservative inline-code recognizer: paths, not arbitrary versions, prose or shell flags. */
export function isFilePathCode(value: string) {
  const { path } = splitLine(value)
  if (!path || /\s|^(?:https?:|mailto:)|^-/.test(path)) return false
  if (path === '.' || path === '..' || /^(?:npm|e\.g\.|and\/or)$/i.test(path)) return false
  if (path.includes('/')) return true
  return (
    /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(path) &&
    !/^\d+\.\d+$/.test(path) &&
    !/^v\d+\.\d+$/.test(path)
  )
}
