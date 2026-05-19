// HTML scaffold generator. The extension itself does NOT call the LLM
// — generation prompts go through the host's configured model. What
// `generator.ts` produces is a SCAFFOLD: a self-contained HTML document
// with a `<style id="design-tokens">` block populated from the project's
// design system, a Tailwind CDN link, and a placeholder body the agent
// is expected to replace via subsequent edit calls.
//
// The scaffold is the architectural anchor for `tweak-design` — the
// agent must author the body in terms of the CSS variables defined in
// the token block, otherwise knob changes don't propagate.

import type { DesignSystem, DraftMeta } from "./types";

const TAILWIND_CDN = "https://cdn.jsdelivr.net/npm/tailwindcss@3.4.0/dist/tailwind.min.css";

export interface ScaffoldInput {
  meta: DraftMeta;
  designSystem: DesignSystem;
  /** When true, drafts ship without the Tailwind CDN link. The body
   *  uses raw CSS-variable references (e.g.
   *  `style="padding: var(--space-4)"`) instead of utility classes. */
  inlineTailwind?: boolean;
  /** Body markup authored by the calling agent. The scaffold wraps it
   *  with the `<style id="design-tokens">` block + Tailwind CDN link.
   *  When omitted, a labeled placeholder is rendered so the missing
   *  body is visible at a glance instead of looking broken. */
  bodyMarkup?: string;
}

export function buildScaffold({ meta, designSystem, inlineTailwind, bodyMarkup }: ScaffoldInput): string {
  const tokensCss = buildTokensBlock(designSystem);
  const tailwindLink = inlineTailwind
    ? ""
    : `<link rel="stylesheet" href="${TAILWIND_CDN}" />`;

  const body = bodyMarkup && bodyMarkup.trim().length > 0
    ? `<!-- Prompt: ${escapeHtml(meta.prompt)} -->
<!-- Kind: ${meta.kind} -->
${bodyMarkup}`
    : `<!-- TODO: agent must call generate-design with bodyMarkup. This placeholder is shown when the call omitted it. -->
<!-- Prompt: ${escapeHtml(meta.prompt)} -->
<!-- Kind: ${meta.kind} -->
<main style="min-height: 100vh; display: grid; place-items: center; background: var(--color-bg); color: var(--color-fg); font-family: var(--font-body); padding: calc(var(--space-unit) * 4);">
  <article style="max-width: 64rem; width: 100%;">
    <h1 style="font-family: var(--font-display); font-size: 3rem; color: var(--color-primary); margin-bottom: calc(var(--space-unit) * 2);">
      ${escapeHtml(meta.prompt)}
    </h1>
    <p style="font-size: 1.125rem; line-height: 1.6;">
      Body to be authored by the agent — use the design tokens declared in the &lt;style id="design-tokens"&gt; block above.
    </p>
  </article>
</main>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(meta.prompt)}</title>
  <style id="design-tokens">
${tokensCss}
  </style>
  ${tailwindLink}
  <style>
    body { margin: 0; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Build the `:root { … }` declarations from a DesignSystem. Exported
 * so `package-handoff` can re-emit the same CSS variables into a
 * standalone tokens.css file.
 */
export function buildTokensBlock(ds: DesignSystem): string {
  const lines: string[] = [":root {"];

  // Colors
  lines.push(`  --color-primary: ${ds.colors.primary};`);
  if (ds.colors.secondary) {
    lines.push(`  --color-secondary: ${ds.colors.secondary};`);
  }
  if (ds.colors.neutral.length > 0) {
    ds.colors.neutral.forEach((hex, idx) => {
      lines.push(`  --color-neutral-${idx + 1}: ${hex};`);
    });
    // Map first to bg, last to fg by convention (greenfield-friendly).
    lines.push(`  --color-bg: ${ds.colors.neutral[ds.colors.neutral.length - 1]};`);
    lines.push(`  --color-fg: ${ds.colors.neutral[0]};`);
  } else {
    lines.push(`  --color-bg: #ffffff;`);
    lines.push(`  --color-fg: #0a0a0a;`);
  }

  // Typography
  lines.push(`  --font-display: ${ds.typography.display};`);
  lines.push(`  --font-body: ${ds.typography.body};`);
  if (ds.typography.mono) {
    lines.push(`  --font-mono: ${ds.typography.mono};`);
  }
  ds.typography.scale.forEach((px, idx) => {
    lines.push(`  --font-size-${idx + 1}: ${px}px;`);
  });

  // Spacing
  lines.push(`  --space-unit: ${ds.spacing.unit}px;`);
  ds.spacing.scale.forEach((px, idx) => {
    lines.push(`  --space-${idx + 1}: ${px}px;`);
  });

  // Radii — derived from the spacing unit by default; tweakable.
  lines.push(`  --radius-base: ${Math.max(2, Math.round(ds.spacing.unit / 2))}px;`);
  lines.push(`  --radius-large: ${ds.spacing.unit}px;`);

  lines.push("}");
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
