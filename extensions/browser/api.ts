/** Browser: the Chromium the screenshot and browser tools launch. Other extensions read whether it is out of date. */
import { defineApi } from '../../shared/extension-api.ts'

/** The Chromium at `path`: its version and, when it is out of date, why (`stale`) and the command that updates it. */
export type ChromiumStatus = { path: string; version?: string; stale?: string; update?: string }

export interface BrowserService {
  /** The Chromium the tools would launch, read offline and cached; undefined when none is installed. */
  chromium(): Promise<ChromiumStatus | undefined>
}
/** The browser tools' Chromium; `want` it, since browser is optional. */
export const BrowserApi = defineApi<BrowserService>()('browser')
