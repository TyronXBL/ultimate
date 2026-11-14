import { expect, it } from 'vitest'
import { remoteCommand } from '../lib/remote-job.ts'

const cwd = '/work/my-app'
const commands = ['pnpm check', 'pnpm test', 'pnpm test:e2e', 'pnpm vitest run']

it.each([
  // What a copy of the checkout runs the same way.
  ['pnpm check', true],
  ['pnpm test test/a.test.ts extensions/b/', true],
  ['pnpm check && pnpm vitest run test/a.test.ts 2>&1 | tail -40', true],
  [
    `pnpm test:e2e test/e2e/a.test.ts -t 'stays at the $bottom' | grep -E "✓|×|FAIL" | head -n 5`,
    true,
  ],
  ['pnpm check; pnpm test test/a.test.ts || pnpm test test/a.test.ts', true],
  ['pnpm check | grep -v -e warning -e note -A 2 | wc -l', true],
  // Not the project's invocations: an unlisted program or script, a listed one only as a prefix of another word.
  ['pnpm fix', false],
  ['pnpm testing', false],
  ['pnpm check && git commit -m done', false],
  ['CI=1 pnpm check', false],
  ['pnpm check | tee out.log', false],
  ['', false],
  ['pnpm check &&', false],
  // Shell that reads this machine or writes: variables, substitution, redirects, groups, background.
  ['pnpm test $FILES', false],
  ['pnpm test "$(git diff --name-only)"', false],
  ['pnpm test `cat list`', false],
  ['pnpm check > out.log', false],
  ['pnpm check 2> errors.log', false],
  ['(pnpm check)', false],
  ['pnpm check &', false],
  ['for i in 1 2; do pnpm check; done', false],
  ['pnpm test "unclosed', false],
  // Anything outside the checkout: another folder, an absolute path, the home, a parent.
  ['cd /work/other && pnpm check', false],
  ['pnpm vitest run --config=/tmp/vitest.config.ts', false],
  ['pnpm test ~/a.test.ts', false],
  ['pnpm test ../other/a.test.ts', false],
  ['pnpm vitest run -c/etc/vitest.config.ts', false],
  // A filter reads the pipe only: no file to read or write, by operand or by option.
  ['pnpm check | grep -f /etc/passwd', false],
  ['pnpm check | grep -f/etc/passwd', false],
  ['pnpm check | grep error package.json', false],
  ['pnpm check | tail -n 5 package.json', false],
  ['pnpm check | sort -o out.txt', false],
  ['pnpm check | wc -l --files0-from=list', false],
])('a command runs remotely only when it is made of the listed invocations: %s', (command, ok) => {
  expect(remoteCommand(command, cwd, commands)).toBe(ok ? command : undefined)
})

it("leaves a leading cd into the job's own folder out of what runs remotely: the copy lives elsewhere", () => {
  expect(remoteCommand(`cd ${cwd} && pnpm check | tail -5`, cwd, commands)).toBe(
    'pnpm check | tail -5',
  )
})
