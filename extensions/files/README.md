Read project files in the browser, on main or in a branch's worktree: rendered Markdown, highlighted code and images.

**Scopes.** The project checkout (labelled by its branch, usually `main`) and the working tree of every ready
worktree, so a branch's uncommitted files show as they are on disk. A branch that concluded without landing has its
worktree released; its files then come from its branch's last commit, read through Git (`ls-tree`, `cat-file`), never
the filesystem. A path a conversation wrote resolves in its own worktree or, released, its branch first.

**What may be read.** The browser names a scope and a relative path, never an absolute one. A file is served only
when all of these hold:

1. Git lists it in that scope: tracked, or untracked and not ignored (`git ls-files -co --exclude-standard`), or, at
   a commit, committed there. Ignored files (`.env`, `node_modules`, build output) are never served.
2. Its real path, symlinks resolved, stays inside the scope's root. At a commit, each link's target must stay inside
   the committed tree and pass this rule itself.
3. Its name does not suggest secrets: `.env*`, `secrets.json`, `auth.json`, `*credentials*`, `*.pem`, `*.key`,
   `id_*` (not `.pub`), `.netrc`, `.npmrc`, or anything under `.ssh/`.

It never goes through Vite's `/@fs` route.

Links: `/?files=<path>&scope=<id>&line=<n>` opens Files at that file (in conversation `id`'s worktree when `scope` is
given), and the address carries `?files=` while Files is on screen. `openFile({ conversation?, path, line? })` from
`ui.tsx` does the same from code.

Actions (`refs.ts`): `scopes`, `tree { conversation? }`, `read { conversation?, path }`, `locate { path, conversation? }`.
