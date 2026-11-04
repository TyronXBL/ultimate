/**
 * What the browser tools may open: this UI, previews, loopback, private and tailnet addresses, and local files. Public
 * pages are read with web_fetch, which runs no JavaScript; a Chromium with a known hole never renders them.
 */
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { BlockList, connect, createServer, isIP, type Socket } from 'node:net'

/** Loopback, private (RFC 1918, IPv6 ULA), link-local and tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) addresses. */
const local = new BlockList()
for (const [network, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
] as const)
  local.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  local.addSubnet(network, prefix, 'ipv6')

/** IPv4-mapped IPv6 is refused by its prefix: a BlockList check would compare it with the IPv4 subnets. */
function isLocal(address: string) {
  const family = isIP(address)
  if (family === 0 || (family === 6 && /^::ffff:/i.test(address))) return false
  return local.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * The addresses to connect to for `host`, checked: every address a name resolves to must be local. `unresolved` marks
 * a name that does not resolve, which is no scope question.
 */
async function resolveLocal(
  host: string,
): Promise<{ addresses: string[] } | { reason: string; unresolved?: boolean }> {
  const name = host.replace(/^\[|\]$/g, '')
  if (isIP(name))
    return isLocal(name) ? { addresses: [name] } : { reason: `${name} is a public address` }
  // A failed lookup reads as no addresses, reported below.
  const addresses = await lookup(name, { all: true }).catch(() => [])
  if (!addresses.length) return { reason: `${name} does not resolve`, unresolved: true }
  const outside = addresses.find((entry) => !isLocal(entry.address))
  return outside
    ? { reason: `${name} resolves to ${outside.address}, a public address` }
    : { addresses: addresses.map((entry) => entry.address) }
}

/** A socket to the first of `addresses` that accepts (`localhost` may list `::1` before an IPv4-only server's `127.0.0.1`). */
async function open(addresses: string[], port: number) {
  for (const [index, address] of addresses.entries()) {
    const socket = connect(port, address)
    try {
      await once(socket, 'connect')
      return socket
    } catch (error) {
      socket.destroy()
      if (index === addresses.length - 1) throw error
    }
  }
  throw new Error('no address to connect to')
}

const SCOPE =
  "the browser tools open only Ultimate's UI, previews, loopback, private and tailnet addresses and local files; read public pages with web_fetch, which runs no JavaScript"

/** Why the browser tools refuse to open `url`, or undefined when it is in scope. */
export async function refusal(url: URL) {
  if (['file:', 'data:', 'about:'].includes(url.protocol)) return undefined
  if (!['http:', 'https:'].includes(url.protocol))
    return `Refused ${url.href}: ${url.protocol} URLs are not opened; ${SCOPE}.`
  const target = await resolveLocal(url.hostname)
  if (!('reason' in target)) return undefined
  return target.unresolved
    ? `Cannot open ${url.href}: ${target.reason}.`
    : `Refused ${url.href}: ${target.reason}; ${SCOPE}.`
}

/**
 * A SOCKS5 proxy on loopback that every connection of a browser context goes through: it connects only to local
 * addresses, to the one it checked (a name cannot resolve again to another), so a redirect, a subresource, a fetch or
 * a WebSocket cannot leave the scope either. `refused` maps each host it refused to the reason.
 */
export async function scopeProxy() {
  const sockets = new Set<Socket>()
  const refused = new Map<string, string>()
  let closed = false
  const server = createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    let buffer = Buffer.alloc(0)
    let greeted = false
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!greeted) {
        // Version 5, then the methods offered: answer "no authentication".
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
        if (buffer[0] !== 5) {
          client.destroy()
          return
        }
        buffer = buffer.subarray(2 + buffer[1])
        greeted = true
        client.write(Buffer.from([5, 0]))
      }
      const request = parseConnect(buffer)
      if (!request) return
      // Paused until piped, so nothing the client sends next is lost.
      client.off('data', onData).pause()
      if ('error' in request) client.end(reply(request.error))
      else forward(client, request).catch(() => client.destroy())
    }
    client.on('data', onData)
  })
  const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])
  async function forward(client: Socket, request: { host: string; port: number; rest: Buffer }) {
    const target = await resolveLocal(request.host)
    if ('reason' in target) {
      refused.set(request.host, target.reason)
      // 2: connection not allowed by ruleset.
      client.end(reply(2))
      return
    }
    let upstream: Socket
    try {
      upstream = await open(target.addresses, request.port)
    } catch {
      // 5: connection refused, as the server's own refusal would read without the proxy.
      client.end(reply(5))
      return
    }
    // The call ended, or the browser gave up, while this connection was resolving or connecting.
    if (closed || client.destroyed) {
      upstream.destroy()
      return
    }
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
    client.write(reply(0))
    upstream.write(request.rest)
    client.pipe(upstream).pipe(client)
  }
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    server: `socks5://127.0.0.1:${port}`,
    refused,
    close() {
      closed = true
      server.close()
      for (const socket of sockets) socket.destroy()
    },
  }
}

/** A SOCKS5 CONNECT request: its host and port and the bytes after it, an error reply code, or undefined while incomplete. */
function parseConnect(
  buffer: Buffer,
): { host: string; port: number; rest: Buffer } | { error: number } | undefined {
  if (buffer.length < 5) return undefined
  // 7: command not supported (only CONNECT); 8: address type not supported.
  if (buffer[0] !== 5 || buffer[1] !== 1) return { error: 7 }
  const type = buffer[3]
  const [start, length] =
    type === 1 ? [4, 4] : type === 4 ? [4, 16] : type === 3 ? [5, buffer[4]] : []
  if (start === undefined || length === undefined) return { error: 8 }
  const end = start + length
  if (buffer.length < end + 2) return undefined
  const address = buffer.subarray(start, end)
  const host =
    type === 1
      ? [...address].join('.')
      : type === 4
        ? (address.toString('hex').match(/.{4}/g) ?? []).join(':')
        : address.toString()
  return { host, port: buffer.readUInt16BE(end), rest: buffer.subarray(end + 2) }
}
