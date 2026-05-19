// CSS-variable knob transform — the load-bearing piece of claude-design.
//
// Drafts are authored with a `<style id="design-tokens">` block at the
// top of <head> declaring `:root { --color-*: …; --space-*: …; … }`.
// The body's CSS uses `var(--color-primary)`, `calc(var(--space-unit) * 4)`,
// etc. — so a knob change ("+10% spacing", "primary = #ff0066") is a
// single rewrite of one CSS-variable's value, not a body-wide grep.
//
// This module is pure: in-string transforms, no I/O, no parsing
// libraries. We're not building a CSS parser — the `<style>` block
// has a known shape (`:root { … }` flat declarations) and we operate
// on it via line-oriented regex. Anything more sophisticated would
// be over-engineered.

import type { KnobDescriptor, Knobs } from "./types";

const TOKEN_BLOCK_RE =
  /<style\s+id="design-tokens"[^>]*>([\s\S]*?)<\/style>/i;

/** Extract the inner contents of the `<style id="design-tokens">` block
 *  from an HTML document. Returns `null` when the block is absent. The
 *  returned string is the raw declaration body (no surrounding tags) —
 *  exactly what `meta.originalTokensBlock` snapshots on first generate. */
export function extractTokensBlock(html: string): string | null {
  const match = TOKEN_BLOCK_RE.exec(html);
  return match ? (match[1] ?? "") : null;
}

/** Replace the inner contents of the `<style id="design-tokens">` block
 *  in an HTML document. Used by `applyKnobsToDraft` to restore the
 *  original snapshot before knob application, so successive applies
 *  scale against the baseline rather than compounding on already-scaled
 *  values. Returns the input unchanged when the block is absent. */
export function replaceTokensBlock(html: string, newInner: string): string {
  return html.replace(TOKEN_BLOCK_RE, (full, oldInner: string) =>
    full.replace(oldInner, newInner),
  );
}

export interface ApplyKnobsResult {
  /** The full HTML with the token block rewritten. */
  html: string;
  /** Names of CSS variables actually changed (for audit/log). */
  changedVars: string[];
}

// ── Legacy descriptor set ───────────────────────────────────────────
//
// The original five-knob set the canvas card used to render before
// descriptor-driven sidebars landed. Used as a fallback for legacy
// drafts (`meta.knobs` absent) so the user keeps seeing the same
// controls and the canvas continues to round-trip values through
// `applyKnobs(html, values as Knobs)`.

export const LEGACY_DESCRIPTORS: KnobDescriptor[] = [
  {
    key: "primaryColor",
    label: "Primary color",
    kind: "color",
    var: "--color-primary",
  },
  {
    key: "secondaryColor",
    label: "Secondary color",
    kind: "color",
    var: "--color-secondary",
  },
  {
    key: "borderRadius",
    label: "Border radius",
    kind: "range",
    var: "--radius-base",
    unit: "px",
    min: 0,
    max: 32,
    step: 1,
  },
  {
    key: "spacingScale",
    label: "Spacing scale",
    kind: "text",
    behavior: "scale-spacing",
  },
  {
    key: "density",
    label: "Density",
    kind: "select",
    options: ["compact", "cozy", "spacious"],
    behavior: "scale-spacing",
  },
];

/**
 * Apply a structured knob bundle to the design-tokens block of a
 * draft. Returns new HTML + the list of CSS variable names changed.
 *
 * Throws when:
 *   - the input HTML doesn't contain a `<style id="design-tokens">` block
 *   - a knob value fails to parse (e.g. spacingScale="not-a-number")
 *
 * Body markup is NEVER touched — the entire transform happens inside
 * the token block. That's the architectural invariant: drafts authored
 * against CSS variables are tweakable; drafts with inlined literals
 * are not.
 *
 * Thin shim — synthesizes descriptors for the legacy five keys and
 * delegates to `applyKnobsByDescriptors`.
 */
export function applyKnobs(html: string, knobs: Knobs): ApplyKnobsResult {
  // Map legacy `Knobs` shape → values keyed by descriptor `key`.
  const values: Record<string, string> = {};
  if (knobs.primaryColor !== undefined) values.primaryColor = knobs.primaryColor;
  if (knobs.secondaryColor !== undefined) values.secondaryColor = knobs.secondaryColor;
  if (knobs.borderRadius !== undefined) values.borderRadius = knobs.borderRadius;
  if (knobs.spacingScale !== undefined) values.spacingScale = knobs.spacingScale;
  if (knobs.density !== undefined) values.density = knobs.density;

  return applyKnobsByDescriptors(html, LEGACY_DESCRIPTORS, values);
}

/**
 * Descriptor-driven knob applier. Walks each descriptor, looks up its
 * value in `values`, and rewrites the appropriate CSS variable in the
 * design-tokens block. Pure — body markup is untouched.
 *
 * Resolution rules per descriptor.kind:
 *   - "color" / "text" / "select" → write the raw value into the
 *     descriptor's CSS variable. For `behavior: "scale-spacing"`, we
 *     instead rescale every `--space-*`/`--radius-*` and SKIP the
 *     direct var write.
 *   - "range" → format `${value}${unit ?? "px"}` and write to the var.
 */
export function applyKnobsByDescriptors(
  html: string,
  descriptors: KnobDescriptor[],
  values: Record<string, string>,
): ApplyKnobsResult {
  const match = TOKEN_BLOCK_RE.exec(html);
  if (!match) {
    throw new Error(
      "[claude-design.tweak] Draft does not contain a `<style id=\"design-tokens\">` block. " +
        "Body must be authored against CSS variables for tweaks to work.",
    );
  }
  const block = match[1] ?? "";
  let next = block;
  const changed: string[] = [];

  // First pass: scaling pseudo-knobs (spacingScale takes precedence
  // over density when both are present — mirrors legacy behavior so
  // the canvas's "1.1 × 1.25 = 1.375x" composition doesn't surprise).
  let spacingFactor: number | null = null;
  for (const d of descriptors) {
    if (d.behavior !== "scale-spacing") continue;
    const raw = values[d.key];
    if (raw === undefined || raw === "") continue;
    // Density-style descriptors with `kind: "select"` carry compact|cozy|spacious.
    if (d.kind === "select") {
      const factor = densityFactor(raw);
      if (factor !== null) {
        // Spacing input wins on conflict — only set if not already filled
        // by an earlier scale-spacing descriptor of kind "text".
        if (spacingFactor === null) spacingFactor = factor;
      }
    } else {
      // text/range scale descriptors expect a parseable factor expression.
      try {
        spacingFactor = parseScaleFactor(raw);
      } catch {
        // Garbage — ignore (mirrors prior best-effort behavior on density).
      }
    }
  }
  if (spacingFactor !== null && spacingFactor !== 1) {
    const { html: rewritten, changed: vars } = scaleSpacing(next, spacingFactor);
    if (vars.length > 0) {
      next = rewritten;
      changed.push(...vars);
    }
  }

  // Second pass: per-var rewrites (color / text / select / range —
  // everything that targets a single CSS variable).
  for (const d of descriptors) {
    if (d.behavior === "scale-spacing") continue;
    const raw = values[d.key];
    if (raw === undefined || raw === "") continue;
    const varName = d.var ?? `--${kebab(d.key)}`;
    let formatted: string;
    if (d.kind === "range") {
      // Bare numbers get the descriptor's unit appended (default px).
      const unit = d.unit ?? "px";
      formatted = /^\d+(\.\d+)?$/.test(raw) ? `${raw}${unit}` : raw;
    } else {
      // color / text / select: write raw.
      formatted = raw;
    }
    const rewritten = setVariable(next, varName, formatted);
    if (rewritten !== next) {
      next = rewritten;
      changed.push(varName);
    }
  }

  const fullHtml = html.replace(TOKEN_BLOCK_RE, (full) =>
    full.replace(block, next),
  );

  return { html: fullHtml, changedVars: changed };
}

// ── Helpers ────────────────────────────────────────────────────────

/** kebab-case converter for descriptor keys: `primaryColor` → `primary-color`.
 *  Insert a `-` before every uppercase letter (except at position 0) and
 *  lowercase the result. Pure ASCII — descriptor keys are JS identifiers. */
function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Replace `--<name>: <oldValue>;` with `--<name>: <newValue>;`. The
 *  old value is captured loosely (anything up to the next semicolon
 *  or close brace). Returns the input unchanged if the variable
 *  isn't declared. */
function setVariable(block: string, name: string, value: string): string {
  // Escape regex metacharacters in the name (e.g. `--color-primary`).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped}\\s*:\\s*)([^;}]*)([;}])`, "g");
  return block.replace(re, (_, prefix: string, _old: string, suffix: string) =>
    `${prefix}${value}${suffix}`,
  );
}

/**
 * Parse a scale factor expression. Accepts:
 *   "1.2" / ".75" → numeric multiplier
 *   "120%" / "75%" → percentage as multiplier (1.2 / 0.75)
 *   "+10%" / "-5%" → relative delta (1.1 / 0.95)
 */
export function parseScaleFactor(input: string): number {
  const s = input.trim();
  // "+N%" or "-N%"
  const rel = /^([+-])(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (rel) {
    const sign = rel[1] === "+" ? 1 : -1;
    const n = parseFloat(rel[2]!);
    return 1 + (sign * n) / 100;
  }
  // "N%" (absolute percentage)
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) return parseFloat(pct[1]!) / 100;
  // Bare numeric multiplier — bounded to [0.1, 5] to catch the common
  // mistake where a px-unit slider value (e.g. `"12px"` from a
  // mis-declared `behavior: "scale-spacing"` descriptor with `unit: "px"`)
  // is treated as a 12× multiplier and blows up every spacing token.
  const num = parseFloat(s);
  if (Number.isFinite(num) && num > 0) {
    if (num > 5) {
      throw new Error(
        `[claude-design.tweak] scale factor ${num} > 5 is almost certainly a misencoded value. ` +
          `For scale-spacing knobs, send signed-delta percentages (e.g. "+30%", "-15%") or a ` +
          `multiplier in [0.1, 5]. Got: ${JSON.stringify(input)}`,
      );
    }
    return num;
  }
  throw new Error(
    `[claude-design.tweak] Cannot parse scale factor: ${JSON.stringify(input)}`,
  );
}

/** Multiply every numeric `--space-*` and `--radius-*` value in the
 *  block by `factor`. Values without units are treated as px. */
export function scaleSpacing(
  block: string,
  factor: number,
): { html: string; changed: string[] } {
  const changed: string[] = [];
  // Match `--<name>: <number><unit?>;` where name starts with "space-" or "radius-".
  // Captures: 1=name, 2=number, 3=unit (optional), 4=trailing.
  const re = /--(space-[a-zA-Z0-9_-]+|radius-[a-zA-Z0-9_-]+)\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)?\s*;/g;
  const next = block.replace(re, (_, name: string, num: string, unit: string | undefined) => {
    const scaled = parseFloat(num) * factor;
    // Round to 3 decimals, drop trailing zeros.
    const rounded = +scaled.toFixed(3);
    changed.push(`--${name}`);
    return `--${name}: ${rounded}${unit ?? "px"};`;
  });
  return { html: next, changed };
}

function densityFactor(density: string): number | null {
  switch (density) {
    case "compact":
      return 0.75;
    case "cozy":
      return 1;
    case "spacious":
      return 1.25;
    default:
      return null;
  }
}
