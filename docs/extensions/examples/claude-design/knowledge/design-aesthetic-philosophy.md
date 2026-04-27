# Design aesthetic philosophy

Adapted from Anthropic's `frontend-design` SKILL.md, with one critical change: when a project's design system carries explicit tokens, **conform** — bold-aesthetic mode applies only in greenfield (source: `greenfield`).

## When tokens exist (conformant mode)

- Read `design-system.json`. Use those colors, fonts, spacing.
- The body's CSS uses `var(--color-primary)`, `calc(var(--space-unit) * N)`, `font-family: var(--font-display)`, etc.
- Don't override brand decisions silently. If the user asks for "a warmer feel" but the brand is cold, surface the conflict and propose the change explicitly.

## When greenfield (bold mode)

Commit to a single, BOLD aesthetic. Don't average between options. Pick one:

- **Brutalist**: monospace bodies, raw HTML elements, harsh contrast, no shadows.
- **Editorial**: serif headlines (think Tiempos / GT Sectra), generous leading, narrow measure.
- **Retro-futuristic**: gradients (real ones, not "linear-gradient pastel"), grain, shimmer.
- **Refined minimalism**: tight typography (Söhne, Inter Display, GT America), high white space, microcopy.
- **Maximalist**: oversized type, layered cards, shadow stacks, color drama.
- **Industrial / utilitarian**: Bloomberg-terminal density, monospace, status indicators everywhere.

### NEVER default to

- Inter / Roboto / Arial / Space Grotesk for headlines (use them only if the brand demands it).
- Purple-to-pink gradient on white. AI-slop signature.
- Centered hero with three-card grid below.

### Do

- Pair display + body fonts intentionally (Söhne Breit + Söhne; GT Sectra + GT America).
- Pick a real color system: a brand color, a sharp neutral ramp (5+ steps), one accent.
- Use animation as content, not decoration.
- Establish a spatial rhythm — pick a unit (8px, 12px, etc.) and stick to it.

## Hard rules

1. **No filler.** Every component should have a reason for being in the design.
2. **No half-effort.** If you commit to a style, commit fully — don't water it down.
3. **Drafts are CSS-variable-driven.** Body markup uses `var(--*)`, never inline literals.
