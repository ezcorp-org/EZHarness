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

import type { Knobs } from "./types";

const TOKEN_BLOCK_RE =
  /<style\s+id="design-tokens"[^>]*>([\s\S]*?)<\/style>/i;

export interface ApplyKnobsResult {
  /** The full HTML with the token block rewritten. */
  html: string;
  /** Names of CSS variables actually changed (for audit/log). */
  changedVars: string[];
}

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
 */
export function applyKnobs(html: string, knobs: Knobs): ApplyKnobsResult {
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

  if (knobs.primaryColor !== undefined) {
    const rewritten = setVariable(next, "--color-primary", knobs.primaryColor);
    if (rewritten !== next) {
      next = rewritten;
      changed.push("--color-primary");
    }
  }
  if (knobs.secondaryColor !== undefined) {
    const rewritten = setVariable(next, "--color-secondary", knobs.secondaryColor);
    if (rewritten !== next) {
      next = rewritten;
      changed.push("--color-secondary");
    }
  }
  if (knobs.borderRadius !== undefined) {
    const rewritten = setBorderRadius(next, knobs.borderRadius);
    if (rewritten !== next) {
      next = rewritten;
      changed.push("--radius-base");
    }
  }
  // spacingScale and density both rescale the same set of variables,
  // so we apply at most ONE — `spacingScale` takes precedence when
  // both are set (it's the more specific user input). Otherwise, when
  // either is supplied alone, that one applies. Composing multiplicatively
  // produced surprising "1.1 × 1.25 = 1.375x" outcomes from the canvas
  // sliders. [I1 from the Phase B review]
  let spacingFactor: number | null = null;
  if (knobs.spacingScale !== undefined) {
    spacingFactor = parseScaleFactor(knobs.spacingScale);
  } else if (knobs.density !== undefined) {
    spacingFactor = densityFactor(knobs.density);
  }
  if (spacingFactor !== null && spacingFactor !== 1) {
    const { html: rewritten, changed: vars } = scaleSpacing(next, spacingFactor);
    if (vars.length > 0) {
      next = rewritten;
      changed.push(...vars);
    }
  }

  const fullHtml = html.replace(TOKEN_BLOCK_RE, (full) =>
    full.replace(block, next),
  );

  return { html: fullHtml, changedVars: changed };
}

// ── Helpers ────────────────────────────────────────────────────────

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

function setBorderRadius(block: string, value: string): string {
  // Accept bare numbers as px.
  const px = /^\d+(\.\d+)?$/.test(value) ? `${value}px` : value;
  return setVariable(block, "--radius-base", px);
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
  // Bare numeric multiplier
  const num = parseFloat(s);
  if (Number.isFinite(num) && num > 0) return num;
  throw new Error(
    `[claude-design.tweak] Cannot parse scale factor: ${JSON.stringify(input)}`,
  );
}

/** Multiply every numeric `--space-*` and `--radius-*` value in the
 *  block by `factor`. Values without units are treated as px. */
function scaleSpacing(
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

function densityFactor(density: "compact" | "cozy" | "spacious"): number {
  switch (density) {
    case "compact":
      return 0.75;
    case "cozy":
      return 1;
    case "spacious":
      return 1.25;
  }
}
