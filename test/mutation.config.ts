// The Vitest config scripts/mutate.ts gives Stryker: the project's, limited to the test files it selected.
import config from '../vite.config.ts'

export default {
  ...config,
  test: { ...config.test, include: JSON.parse(process.env.MUTATE_TESTS ?? '[]') as string[] },
}
