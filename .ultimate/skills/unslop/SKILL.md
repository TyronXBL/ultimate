---
name: unslop
description: In this project, an audit of Ultimate's UI against unslop's signs of AI-looking UI (glows, gradients, emoji labels, tracked uppercase, pulsing, uneven spacing), run through `ui-craft`. Use when someone asks to unslop, de-slop or clean up a screen of Ultimate.
license: CC-BY-4.0
metadata:
  author: Damir Sokolovsky
  site: https://heydamir.design/unslop
---

# Unslop, for Ultimate

unslop was created by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)) and is licensed under CC BY 4.0; this
project override keeps only its audit.

Ultimate already has a design system: its theme, density and the `ui-craft` skill. unslop's own process gives a
screen a new direction and look, which here would fight that system. So in this project:

1. Read `.ultimate/skills/ui-craft/SKILL.md` and follow it: it owns the audit, the evidence and the fixes.
2. Use unslop's signs checklist (`references/signs.md` of the user's `unslop` skill, `~/.ultimate/skills/unslop/`,
   when installed) only as a list of things to look for during that audit.
3. Skip unslop's Direction, its fix passes (spacing through motion), its tokens, the signature detail, generated
   visuals and the story video. Every fix uses Ultimate's existing theme tokens and primitives.
