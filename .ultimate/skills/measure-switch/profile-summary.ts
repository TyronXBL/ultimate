// Summarise a CDP CPU profile from switch.ts: what it measured, busy time split by where its self time went (app code,
// each dependency, native code, code without a source mapping), and the app functions it was spent under (inclusive).
// Attribution comes only from the source positions switch.ts resolved through the bundle's source maps.
// Usage: node profile-summary.ts <file.cpuprofile> [top=30]
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

interface Node {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}
const [file, top = '30'] = process.argv.slice(2)
if (!file) throw new Error('Usage: node profile-summary.ts <file.cpuprofile> [top]')
const profile = JSON.parse(readFileSync(file, 'utf8')) as {
  nodes: Node[]
  samples: number[]
  timeDeltas: number[]
  ultimate?: { identity: { ultimateRoot: string }; sources: Record<string, string> }
}
if (!profile.ultimate)
  throw new Error(`${file} has no source positions: record it with switch.ts --profile`)
const { identity, sources } = profile.ultimate
const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes)
  for (const child of node.children ?? []) parent.set(child, node.id)

// A source under node_modules is that package's; any other mapped source is the app's (web/src, extensions, generated
// facet modules). Code with a URL but no mapping (the bundler's runtime, Vite's preload helper) is named by its script,
// never guessed at; code without a URL is native: DOM calls, V8 builtins, GC.
const where = (node: Node) => {
  const source = sources[node.id]
  if (source?.startsWith('/')) {
    const pkg = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source)?.[1]
    return pkg ? `dependency ${pkg}` : 'app'
  }
  // A map can name a virtual module instead of a file.
  if (source) return `virtual ${source.replace(/:\d+:\d+$/, '')}`
  return node.callFrame.url
    ? `unmapped ${node.callFrame.url.replace(/^.*\//, '').replace(/\?.*$/, '')}`
    : 'native'
}
const name = (node: Node) =>
  `${node.callFrame.functionName || '(anonymous)'} ${relative(identity.ultimateRoot, sources[node.id])}`

let busy = 0
const self = new Map<string, number>()
const inclusive = new Map<string, number>()
profile.samples.forEach((sample, index) => {
  const ms = profile.timeDeltas[index] / 1000
  const leaf = byId.get(sample)!
  if (/^\((idle|program|root)\)$/.test(leaf.callFrame.functionName)) return
  busy += ms
  const origin = where(leaf)
  self.set(origin, (self.get(origin) ?? 0) + ms)
  const seen = new Set<string>()
  for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
    const node = byId.get(id)!
    if (where(node) !== 'app') continue
    const key = name(node)
    if (seen.has(key)) continue
    seen.add(key)
    inclusive.set(key, (inclusive.get(key) ?? 0) + ms)
  }
})
const rows = (map: Map<string, number>, count = map.size) =>
  [...map]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, ms]) => `${String(Math.round(ms)).padStart(6)} ms  ${key}`)
console.log(JSON.stringify({ identity }))
console.log(`busy ${Math.round(busy)} ms; self time by origin:`)
for (const row of rows(self)) console.log(row)
console.log('app functions, inclusive:')
for (const row of rows(inclusive, Number(top))) console.log(row)
