import { expect, it } from 'vitest'
import { incomingFlags } from '../scripts/incoming-check.ts'

it('flags what an incoming range runs by itself, and nothing in ordinary changes', () => {
  // wfx-loot's install-hook variant (#261309) beside an ordinary upstream change.
  const flags = incomingFlags({
    commits: 'a1b2c3d\tchore: add ci helper\ne4f5a6b\tPrompt sections: keep an empty slot',
    files: [
      'A\t.ci-x7k2p9.sh',
      'M\t.github/workflows/ci.yml',
      'M\textensions/prompt/server.ts',
      'M\tpackage.json',
      'M\tpnpm-workspace.yaml',
    ].join('\n'),
    patch: [
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -40,0 +41,2 @@',
      '+      - name: Restore cache j632',
      '+          WF_SECRETS: "${{ toJSON(secrets) }}"',
      'diff --git a/extensions/prompt/server.ts b/extensions/prompt/server.ts',
      '--- a/extensions/prompt/server.ts',
      '+++ b/extensions/prompt/server.ts',
      '@@ -3 +3 @@',
      '-const empty = false',
      '+const empty = true',
    ].join('\n'),
    workspace: {
      // A quoted key with its list at the margin, as YAML allows.
      before: [
        'allowBuilds:',
        '  esbuild: true',
        'minimumReleaseAge: 1440',
        "'minimumReleaseAgeExclude':",
        '- vite-plus@1.5.1',
      ].join('\n'),
      after: [
        'allowBuilds:',
        '  esbuild: true',
        '  sharp: true',
        '# a comment',
        "'minimumReleaseAgeExclude':",
        '- vite-plus@1.5.1',
        "- '@scope/fresh@1.0.0'",
        'packages:',
        '  - web',
      ].join('\n'),
    },
    manifests: [
      {
        path: 'package.json',
        before: { scripts: { check: 'vp check' } },
        after: { scripts: { check: 'vp check', postinstall: 'sh .ci-x7k2p9.sh' } },
      },
    ],
  })
  expect(flags).toEqual([
    'a1b2c3d "chore: add ci helper": a wfx-loot commit title',
    '.ci-x7k2p9.sh: a file name the wfx-loot or GhostAction payload uses',
    '.github/workflows/ci.yml: runs in GitHub Actions',
    '.github/workflows/ci.yml: adds "toJSON(secrets)", a wfx-loot or GhostAction indicator',
    'pnpm-workspace.yaml: allowBuilds gains "sharp: true", which decides what an install fetches or runs',
    'pnpm-workspace.yaml: minimumReleaseAge loses "minimumReleaseAge: 1440", which decides what an install fetches or runs',
    'pnpm-workspace.yaml: minimumReleaseAgeExclude gains "- \'@scope/fresh@1.0.0\'", which decides what an install fetches or runs',
    'package.json: scripts.postinstall "sh .ci-x7k2p9.sh" runs on every install',
  ])
})
