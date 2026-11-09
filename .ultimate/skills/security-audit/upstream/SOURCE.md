# Source

Every other file in this folder is a byte-identical copy of `skills/security-audit/` from
[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) at commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14, "Clarify guidance and full audit modes"), plus the repository's
`LICENSE`. Copyright (c) 2025-2026 Cloudflare, Inc., MIT licence; `LICENSE` here is the notice.

Not copied: the repository `README.md` and the validator tests (`validate-findings.test.cjs`,
`validate-coverage-ledger.test.cjs`). Format and lint skip this folder (`vite.config.ts`), so the copy stays
comparable:

```sh
git clone https://github.com/cloudflare/security-audit-skill "$TMPDIR/sas" && git -C "$TMPDIR/sas" checkout c1c8a8c
diff -r "$TMPDIR/sas/skills/security-audit" .ultimate/skills/security-audit/upstream
```

The expected differences are the two missing test files and this `SOURCE.md`. `../SKILL.md` adapts the workflow to
Ultimate and wins every conflict with these files. Adopted in conversation #182046, from the research in #178769.
