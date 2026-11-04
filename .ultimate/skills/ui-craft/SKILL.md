---
name: ui-craft
description: Craft rules and an evidence-gated audit for Ultimate's UI (spacing, type, colour, states, motion, accessibility, Tailwind discipline) inside its own theme and density. Use when building or changing anything a person sees, when auditing a screen for slop or inconsistency, and in every designer brief.
license: Adapted from MIT, Apache-2.0 and CC-BY-4.0 sources; see references/sources.md
---

# UI craft for Ultimate

Ultimate is a dense, quiet, dark-first tool people look at for hours. Good UI here is consistent and calm, never
"distinctive": the theme is the design system, and every rule below works inside it. Credits and licences of the
skills this draws from are in [references/sources.md](references/sources.md).

## Ultimate wins every conflict

These override any rule here, in a source skill or in your own taste:

- **Theme tokens only.** Colours come from `web/src/index.css` utilities (`bg-background`, `text-muted-foreground`,
  `border-border`, `text-warning`, `bg-success/10` …). No raw palette colours (`text-amber-500`, `bg-blue-600`), no
  hex, no `dark:` colour overrides: the tokens already switch with the theme and with the user's custom palettes. Never
  add a font, palette or new token to fix one screen.
- **Brand is rare.** `brand` marks @ultimate's own voice, the one primary action or the current selection on a
  screen; not every button, icon, focus border or status word. Focus uses `ring`.
- **Sentence case** for every label, button, heading and menu item. Section and group headings use the
  `section-label` utility, never `uppercase tracking-*`.
- **Dense rows.** Desktop rows are 24–28 px; touch grows them with `pointer-coarse:h-9`, and small controls in dense
  lines get `touch-target`. Do not loosen rows to "breathe".
- **Hairlines, not shadows.** Structure comes from spacing, surface steps (`background` → `card` → `accent`) and
  `border-border`; shadows only on floating layers (popovers, menus, dialogs).
- **Type scale.** Inter for UI, the mono font for code, ids and section labels. Use the existing steps: 11 px meta
  and labels, 12 px secondary text, 13 px row titles and chrome body, 14 px transcript body. Weights 400 and 500,
  600 rarely. No new half-steps (`text-[11.5px]`, `text-[12.5px]`) in new code; when you touch a screen that mixes
  them, collapse to the steps.
- **Match the neighbour.** Before building, find the closest existing card, row or panel and copy its structure,
  sizes and states (`extensions/subagents/messages.tsx`, `extensions/workspaces/log.tsx`, `extensions/sidebar/`).

## Craft rules

**Hierarchy and spacing**

- One focal point per screen or card. If two things compete, quiet one.
- Spacing on the 4 px grid (Tailwind steps); 2 px only for nudges inside small controls. No one-off
  `mt-[13px]`.
- Space inside a group is smaller than space between groups. Equal things get equal heights, paddings and gaps.
- Use `gap-*` on the parent, not `space-x/y-*`; `size-*` when width equals height. `className` on a shared primitive
  adjusts layout, not its colours.
- Before adding a box, border or divider, try spacing and alignment. Ask of every element: what does it do, and would
  deleting it lose anything? No cards inside cards.
- Icons from lucide, one size per row or toolbar (match its neighbours; `size-3.5` is the usual row icon), coloured
  by their text role. No emoji as icons.

**Text and numbers**

- Labels say what happens ("Launch branch", not "Submit"). No exclamation marks, no trailing periods on short
  strings, no hype words.
- Plurals and counts are right ("1 needs you", "3 need you"). Counts use one format across sibling sections.
- Numbers that change or line up use `tabular-nums`. Long text truncates (`truncate` with `min-w-0` on the flex
  child) or wraps deliberately (`text-pretty`, `break-words` for paths and ids); nothing overlaps.
- Secondary information is muted text, not a coloured pill.

**States**

- Design every state the data can be in: loading, empty, error, one item, many items, a very long name, a narrow
  panel, the phone at 390 px. Feed the worst plausible data before calling it done.
- Interactive elements have hover, `focus-visible`, active, disabled and selected states, all from the tokens.
  Clickable things look clickable; non-clickable things do not change on hover.
- Status colours carry meaning only: `success`, `warning`, `error`/`destructive`, `note`. Waiting is `warning`,
  never a hard-coded amber.
- Prefer a quiet skeleton or a static muted label to a spinner; prefer an inline control or a popover to a modal.

**Motion**

- Animate by how often it happens: things seen many times a day (rows, menus opened by keyboard, tab switches) do
  not animate at all; occasional things get a short fade, under 200 ms for feedback and under 300 ms for entrances.
- A pulse means "live right now". Anything stale, finished or waiting on a person is static.
- Transition named properties (`transition-colors`, `transition-opacity`), never `transition-all`; never animate
  width, height, top or left; no `ease-in`, no scale from 0, no hover scale on cards, no entrance sequences.

**Accessibility**

- Semantic elements: `button` for actions, `a` for navigation, never `div onClick`. Icon-only buttons get
  `aria-label` and a tooltip.
- Never remove an outline without a `focus-visible` replacement. Keyboard order follows the visual order.
- Text on any surface meets contrast in both themes; check light as well as dark.
- Inputs have labels (visible or `aria-label`); errors say what to do next.

## Audit procedure

Use it on an existing screen, and on your own work before reporting.

1. **Look first.** Render the screen with the `verify-ui` skill: dark and light, desktop and `width: 390`, and the
   states above. Judge what people see, then find the code.
2. **Check against the rules.** Go through this file, then the slop signs in
   [references/signs.md](references/signs.md).
3. **Gate every finding.** Keep it only if you can name (a) the rule or neighbouring component it breaks, (b) where
   it shows in the render, and (c) one concrete correction with `file:line`. Drop taste-only findings ("I'd prefer
   another font", "this needs more character").
4. **Report** at most eight findings, grouped by root cause (one cause, several places), worst first. Do not
   prescribe a new direction, palette, font or layout.
5. **Fix** in small rounds: mechanical token and copy fixes first, then states and colour weight, then type scale.
   Re-render after each round and compare with the audit list.
