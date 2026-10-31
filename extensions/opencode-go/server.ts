import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { opencodeLogin } from './login.ts'

const PROVIDER = 'opencode-go'

/**
 * Pi's built-in OpenCode Go provider with a browser login next to its API key. Its catalogue, session header and
 * request code stay Pi's; the login only adds a way to get the token.
 */
export default function opencodeGo(host: ExtensionHost) {
  const runtime = host.modelRuntime
  // Captured once per process: after the first load `getProvider` returns this extension's own registration.
  const builtin = host.resource('opencode-go.builtin', () => {
    const provider = runtime.getProvider(PROVIDER)
    if (!provider) throw new Error(`Pi has no ${PROVIDER} provider`)
    return provider
  })
  // A reload installs the new facet before the old one closes; restore the built-in only when none remain.
  const facets = host.resource('opencode-go.facets', () => new Set<symbol>())
  const facet = Symbol('opencode-go')
  facets.add(facet)
  host.onClose(async () => {
    facets.delete(facet)
    if (!facets.size) runtime.unregisterProvider(PROVIDER)
  })
  runtime.registerNativeProvider({ ...builtin, auth: { ...builtin.auth, oauth: opencodeLogin } })
  return defineExtension({ name: 'opencode-go' })
}
