# Handoff bundle format

`package-handoff` writes a folder under `<projectRoot>/.ezcorp/extension-data/claude-design/handoffs/<projectSlug>-<timestamp>/`. The folder is consumable by Claude Code in two ways:

1. **Mention reference**: `@[dir:.ezcorp/extension-data/claude-design/handoffs/<slug>-<ts>/]`
2. **Slash command**: the bundle ships an `agents/claude-design-implement.md` stub. Drop it into the project's `agents/` directory if you want it discoverable globally.

## Layout

```
handoffs/<slug>-<ts>/
├── README.md                  # Human-facing summary
├── IMPLEMENT.md               # Agent-facing implementation spec
├── design.html                # The chosen draft (renamed)
├── design-system.json         # Tokens
├── tokens.css                 # CSS variables, ready to import
├── knob-trail.json            # How this draft was tweaked from its parent
├── starter/                   # Per targetFramework
│   └── DesignDraft.tsx        # (or .svelte / .vue / .html)
└── agents/
    └── claude-design-implement.md
```

## `IMPLEMENT.md` four-section contract

A Claude Code agent reading the bundle expects exactly these sections:

```markdown
# Implement: <draft title>

## Overview
<one paragraph: what this design is, who it's for, what success looks like>

## Tokens
<embed the design-system.json contents as a code fence + reference tokens.css>

## Components
<list every component the draft uses, with its path in the existing codebase
 (from design-system.json's components catalog) OR a note that it's new>

## Pages
<for each page/section, the route or filepath where it should live, and the
 specific bits of HTML from design.html that map to it>
```

## `tokens.css`

Just the `:root { --color-*: …; --space-*: …; --font-*: … }` block from `design.html`'s `<style id="design-tokens">`. Importable into any framework's global stylesheet.

## `knob-trail.json`

```jsonc
{
  "draftId": "d-3",
  "parentDraftId": "d-2",
  "knobs": { "primaryColor": "#ff0066" },
  "appliedAt": "2026-04-26T20:00:00Z"
}
```

A flat list, NOT a chain — each draft records the single hop from its parent. Reconstruct the full lineage by walking `parentDraftId` back to the root.
