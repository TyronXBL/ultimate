import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { opencodeLogin } from './login.ts'

/**
 * Pi's built-in OpenCode Go provider with a browser login next to its API key. Its catalogue, session header and
 * request code stay Pi's; the login only adds a way to get the token. `models.json` still applies on top.
 */
export default function opencodeGo(host: ExtensionHost) {
  const builtin = opencodeGoProvider()
  // A reload installs the new facet before the old one closes; restore Pi's own only when none remain.
  const facets = host.resource('opencode-go.facets', () => new Set<symbol>())
  const facet = Symbol('opencode-go')
  facets.add(facet)
  host.onClose(async () => {
    facets.delete(facet)
    if (!facets.size) host.modelRuntime.unregisterProvider(builtin.id)
  })
  host.modelRuntime.registerNativeProvider({
    ...builtin,
    auth: { ...builtin.auth, oauth: opencodeLogin },
  })
  return defineExtension({ name: 'opencode-go' })
}
