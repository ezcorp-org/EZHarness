# Design system extraction

`extract-design-system` walks the project root and merges design tokens from these sources, in priority order:

1. **`tokens.json` / `*.tokens.json`** — explicit Style Dictionary or Figma export. Highest priority.
2. **`tailwind.config.{ts,js,cjs,mjs}`** — `theme.colors`, `theme.fontFamily`, `theme.spacing`, `theme.extend.*`.
3. **`:root { --color-*: …; --space-*: …; --font-*: … }`** in any project CSS/SCSS file.
4. **`theme.ts` / `theme.js`** exporting an object with `colors`, `typography`, `spacing` keys.

When NOTHING matches, the source is `"greenfield"` and the agent should pick a bold aesthetic per `design-aesthetic-philosophy`.

## Output schema

```jsonc
{
  "colors": {
    "primary": "#ff0066",
    "secondary": "#0066ff",
    "neutral": ["#0a0a0a", "#262626", "#525252", "#a3a3a3", "#fafafa"]
  },
  "typography": {
    "display": "Söhne Breit, sans-serif",
    "body": "Söhne, sans-serif",
    "mono": "iA Writer Mono, ui-monospace, monospace",
    "scale": [12, 14, 16, 20, 24, 32, 48, 64]   // px
  },
  "spacing": {
    "unit": 8,
    "scale": [4, 8, 12, 16, 24, 32, 48, 64]     // px
  },
  "components": [
    { "name": "Button",  "path": "web/src/lib/components/Button.svelte" },
    { "name": "Card",    "path": "web/src/lib/components/Card.svelte" }
  ],
  "source": "tailwind"
}
```

## Why CSS variables matter

Drafts are authored against CSS variables (`var(--color-primary)`, `calc(var(--space-unit) * 4)`) so a `tweak-design` knob change is a one-line edit to the `<style id="design-tokens">` block. If a generator inlines literal values into the body markup, every knob has to grep-and-replace across the entire HTML — fragile and lossy.

## Component catalog

The catalog is informational — the agent uses it to suggest "use the existing Button" instead of recreating one. Names are top-level `.svelte`/`.tsx`/`.vue`/`.jsx` files under `components/` directories.
