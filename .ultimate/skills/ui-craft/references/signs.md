# Signs of slop in app UI

Adapted from unslop's `references/signs.md` by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0.
Changes: kept only the app-UI groups, dropped landing pages, heroes, visuals and the template-look group (Ultimate's
neutral theme and Inter are deliberate), and pointed every fix at Ultimate's theme tokens instead of unslop's own
palettes. Note each sign you find with where it lives; each line pairs the sign with its fix.

## Colour

- Hue gradients, gradient text, coloured glows or shadows, radial washes → a flat token surface; depth from surface
  steps and `border-border`
- Brand colour on every action, icon, focus border and status word, so nothing stands out → brand on the one primary
  action or selection; focus uses `ring`; the rest `foreground` or `muted-foreground`
- Raw palette colours (`text-amber-500`, `bg-blue-600`) or hex → the semantic token (`text-warning`, `bg-accent`)
- Many near-identical tints for text → the three roles: `foreground`, `muted-foreground`, and `foreground/…` only
  when a neighbour already uses it
- Strong coloured borders → `border-border` or `border-border/60`

## Type

- Uppercase labels with wide tracking (`AGENTS`, `ULTIMATE`) → sentence case with `section-label`, or plain text
- Too many sizes on one screen (11, 11.5, 12, 12.5, 13 px side by side) → the scale steps in SKILL.md
- Numbers in mixed formats, or counts styled differently in sibling sections → one format, `tabular-nums`
- Heavy weights (700+) for hierarchy → size and colour; 500 at most for titles
- Negative tracking on small text, italic for emphasis → none; colour or weight instead

## Icons

- Emoji as icons, status or decoration → a lucide icon or nothing
- Icons in many sizes and colours in one list → one size, the text role colour
- Icons nudged off the column → the same icon box width in every row

## Spacing

- Arbitrary values (`mt-[13px]`, `h-[31px]`) → Tailwind steps on the 4 px grid
- Rows in one list with different heights or gaps → one height, one gap
- Groups closer to their neighbours than to their own items → smaller gaps inside groups, bigger between them
- Content squeezed until it breaks (tags shrunk to `#.`, overlapping labels) → hide or wrap what doesn't fit

## Copy

- Exclamation marks, hype words, wordy placeholders (`Search anything...`) → plain statements, `Search`
- Trailing periods on labels and buttons → none
- Wrong plurals (`1 need you`) → agree with the count

## Components

- Glowing or coloured pills for counts, shortcuts or status → quiet mono text or a keycap
- `New`, `Beta`, `PRO` badges → remove, or one quiet text badge where it matters
- Everything a full pill → radius by size; inner radius = outer radius − padding
- Cards inside cards, boxes around single values → spacing and alignment instead

## Motion

- `animate-pulse` or `animate-ping` on things that are not live (a stale "launching", a waiting state) → static
- `transition-all`, `hover:scale` on cards and buttons → `transition-colors`, a surface step on hover
- Bouncy springs, entrance sequences, parallax → none; one short fade where it explains something
- Animating width, height, top or left → transform and opacity
