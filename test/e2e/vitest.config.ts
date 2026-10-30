import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['test/sweep-temp.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    maxWorkers: 4,
    // As in vite.config.ts: Node loads the extension loader, as in production.
    server: { deps: { external: [/\/server\/extension-loader\.ts$/] } },
  },
})
