// Body-markup lint for claude-design.
//
// The architectural invariant of `tweak-design` is that every visual
// value in the body markup goes through a CSS variable — `var(--color-*)`,
// `calc(var(--space-unit) * N)`, etc. When the agent inlines a literal
// (e.g. `style="color: #ff0066"` or `class="bg-[#ff0066]"`), subsequent
// knob tweaks have no surface to act on and the user gets a static draft.
//
// `lintBodyMarkup` is the server-side enforcement. It's a pure function
// — no I/O, no global state — that scans the body for the three patterns
// the agent is most likely to ship by accident, and returns a structured
// violations list. `generate-design` calls it before scaffolding; on
// failure it returns a `toolError` whose message lists the exact lines
// the agent must fix.
//
// Three rule families:
//   1. Inline-style hex literals on color-bearing properties.
//   2. Inline-style hardcoded px on layout properties.
//   3. Tailwind arbitrary-color classes (`bg-[#…]` / `text-[#…]`).
//
// Each violation includes a 1-based line number and the offending
// substring (truncated to 80 chars). No fancy CSS parser — these
// patterns are well-defined enough to catch with regex, and we'd rather
// have a fast, dependency-free check that occasionally false-positives
// on creative authoring than a heavyweight parser nobody can read.

export type LintRule =
  | "inline-hex"
  | "inline-px"
  | "tailwind-arbitrary-color"
  | "tailwind-color-utility"
  | "tailwind-spacing-utility"
  | "tailwind-sizing-utility"
  | "tailwind-typography-utility"
  | "tailwind-radius-utility";

export interface LintViolation {
  /** Short tag identifying which rule fired. */
  rule: LintRule;
  /** Human-readable message including the offending substring (≤80 chars). */
  message: string;
  /** 1-based line number where the violation begins. */
  line: number;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
}

const SNIPPET_MAX = 80;

/** Line-number lookup: 1-based, computed by counting `\n` before `index`. */
function lineNumberAt(body: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < body.length; i++) {
    if (body.charCodeAt(i) === 10 /* \n */) n++;
  }
  return n;
}

function truncate(s: string): string {
  if (s.length <= SNIPPET_MAX) return s;
  return s.slice(0, SNIPPET_MAX - 3) + "...";
}

const COLOR_PROP_RE =
  /(?:^|;)\s*(color|background|background-color|border-color|fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})/;

const LAYOUT_PROP_RE =
  /(?:^|;)\s*((?:padding|margin|gap|font-size|line-height|width|height|min-width|min-height|max-width|max-height|top|right|bottom|left)(?:-[a-z]+)?)\s*:\s*([^;]+)/g;

const STYLE_ATTR_RE = /style="([^"]*)"/g;

const TAILWIND_ARB_RE =
  /\bclass="[^"]*\b(?:bg|text|border|fill|stroke)-\[#[0-9a-fA-F]{3,8}\][^"]*"/g;

/** Returns true if the value uses a permitted token form (var/calc/0/viewport). */
function isAllowedDimensionValue(raw: string): boolean {
  const v = raw.trim();
  if (v === "0" || v === "0px") return true;
  // Any var(...) or calc(...) reference — even if mixed with literals,
  // we lean permissive because the var() side carries the token. The
  // per-px check below still flags raw `Npx` outside of these wrappers.
  if (/var\(\s*--/.test(v)) return true;
  if (/calc\(/.test(v)) return true;
  return false;
}

/** Returns true if the value contains a literal `Npx` outside var()/calc(). */
function hasHardcodedPx(raw: string): boolean {
  // Strip var(...) and calc(...) wrappers so a value like
  // `calc(var(--space-unit) * 4 + 2px)` doesn't false-positive.
  // The mixed case is rare in our domain — agents either use full tokens
  // or full literals. Stripping is intentionally non-recursive.
  const stripped = raw
    .replace(/var\([^)]*\)/g, "")
    .replace(/calc\([^)]*\)/g, "");
  // After stripping, look for any digit run followed by `px`.
  // Ignore plain `0`/`0px` (already handled by the early-allow path).
  const m = /(\d+(?:\.\d+)?)px/.exec(stripped);
  if (!m) return false;
  const num = m[1] ?? "";
  return num !== "0" && parseFloat(num) !== 0;
}

/**
 * Lint a body-markup string. Returns `{ok, violations}`. Pure;
 * no I/O.
 *
 * The function is permissive by design — false negatives (missed
 * violations) are recoverable (the agent ships a slightly-rough draft);
 * false positives are not (the agent gets stuck in a retry loop).
 * When a value form is ambiguous, we don't flag it.
 */
export function lintBodyMarkup(body: string): LintResult {
  const violations: LintViolation[] = [];

  // ── Rule 1: inline-style hex literals on color-bearing properties ──
  // ── Rule 2: inline-style hardcoded px on layout properties ────────
  //
  // Both rules scan inside `style="..."` attributes — combine the work
  // by first walking style attributes, then evaluating each declaration.

  STYLE_ATTR_RE.lastIndex = 0;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = STYLE_ATTR_RE.exec(body)) !== null) {
    const inner = styleMatch[1] ?? "";
    const styleStart = styleMatch.index;

    // Rule 1: each color-property declaration with a `#…` literal.
    // The COLOR_PROP_RE is non-global; iterate by scanning manually
    // through `;`-separated decls.
    for (const decl of inner.split(";")) {
      const m = COLOR_PROP_RE.exec(";" + decl); // prefix `;` so the alt anchors fire
      if (m) {
        const snippet = truncate(m[0].replace(/^;\s*/, "").trim());
        violations.push({
          rule: "inline-hex",
          message: `inline-style hex literal: ${snippet}`,
          line: lineNumberAt(body, styleStart),
        });
      }
    }

    // Rule 2: layout-property declarations with hardcoded px.
    LAYOUT_PROP_RE.lastIndex = 0;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = LAYOUT_PROP_RE.exec(inner)) !== null) {
      const value = propMatch[2] ?? "";
      // Allow if the entire value is a permitted token form.
      if (isAllowedDimensionValue(value)) continue;
      // Otherwise flag if there's a non-zero `Npx` literal.
      if (!hasHardcodedPx(value)) continue;
      const snippet = truncate(`${propMatch[1]}: ${value.trim()}`);
      violations.push({
        rule: "inline-px",
        message: `inline-style hardcoded px on layout property: ${snippet}`,
        line: lineNumberAt(body, styleStart),
      });
    }
  }

  // ── Rule 3: Tailwind arbitrary-color classes ──────────────────────

  TAILWIND_ARB_RE.lastIndex = 0;
  let twMatch: RegExpExecArray | null;
  while ((twMatch = TAILWIND_ARB_RE.exec(body)) !== null) {
    const snippet = truncate(twMatch[0]);
    violations.push({
      rule: "tailwind-arbitrary-color",
      message: `Tailwind arbitrary-color class: ${snippet}`,
      line: lineNumberAt(body, twMatch.index),
    });
  }

  // ── Rules 4-8: hardcoded Tailwind utility classes (D1 hardening) ──
  //
  // The earlier rules catch literal hex colors and arbitrary-color
  // brackets. A more insidious gap remains: `bg-blue-500`, `p-4`,
  // `text-3xl`, `rounded-lg` are all named Tailwind utilities that
  // bake in literal values from the Tailwind theme — they don't
  // reference our design-system CSS variables, so subsequent
  // `tweak-design` knob tweaks have no surface to act on.
  //
  // Forcing all styling through `var(--…)` arbitraries makes every
  // knob deterministic. The agent must use `bg-[var(--color-primary)]`
  // instead of `bg-blue-500`, `p-[calc(var(--space-unit)*4)]` instead
  // of `p-4`, and so on.
  //
  // Allowlist note: layout utilities (`flex`, `grid`, `block`, `items-*`,
  // `justify-*`, etc.) don't bake values, so they pass without flagging.
  // Only the explicit deny patterns below trigger violations.

  for (const m of body.matchAll(CLASS_ATTR_RE)) {
    const classValue = m[1] ?? "";
    const classStart = (m.index ?? 0) + (m[0].indexOf(classValue));
    for (const tok of classValue.split(/\s+/)) {
      if (!tok) continue;
      const r = classifyTailwindToken(tok);
      if (!r) continue;
      violations.push({
        rule: r.rule,
        message: `${r.label}: ${truncate(tok)}`,
        line: lineNumberAt(body, classStart),
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── D1: hardcoded-utility detectors ──────────────────────────────────

const CLASS_ATTR_RE = /\bclass="([^"]*)"/g;

// Reject `bg-<name>-<NNN>`, `text-<name>-<NNN>`, etc. Allow the
// arbitrary-value form `bg-[var(--…)]` (handled by NOT matching here)
// and the literal-arbitrary form `bg-[#…]` (Rule 3 already flagged).
const TAILWIND_COLOR_UTIL_RE =
  /^(bg|text|border|fill|stroke|ring|divide|placeholder|caret|accent|outline|decoration|from|via|to)-[a-z]+-\d{2,3}$/;

// Reject numeric Tailwind spacing (`p-4`, `mx-2`, `gap-8`, etc.).
// Allow `p-[var(--…)]` / `p-[calc(…)]` (arbitraries don't match here).
const TAILWIND_SPACING_UTIL_RE =
  /^(p|m|px|py|pt|pr|pb|pl|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-(?:\d+(?:\.\d+)?|px|0\.5|1\.5|2\.5|3\.5)$/;

// Reject numeric Tailwind sizing. Allow semantic forms (`w-full`,
// `h-screen`, `min-h-screen`, `w-fit`, `w-auto`, `w-min`, `w-max`).
const TAILWIND_SIZING_UTIL_RE =
  /^(w|h|min-w|min-h|max-w|max-h|size)-(?:\d+(?:\.\d+)?|px|0\.5|1\.5|2\.5)$/;

// Reject named typography sizes. Force `text-[var(--font-size-…)]`.
const TAILWIND_TYPOGRAPHY_UTIL_RE =
  /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/;

// Reject named radius. Force `rounded-[var(--radius-…)]`.
const TAILWIND_RADIUS_UTIL_RE =
  /^rounded(?:-(?:t|r|b|l|tl|tr|bl|br))?-(?:none|sm|md|lg|xl|2xl|3xl|full)$/;

interface TailwindClassification {
  rule: LintRule;
  label: string;
}

function classifyTailwindToken(tok: string): TailwindClassification | null {
  // Tailwind variant prefixes (`hover:`, `md:`, `dark:`, `focus-visible:`,
  // etc.) chain before the utility itself. Strip them so `hover:bg-blue-500`
  // is classified the same as `bg-blue-500`.
  const colonIdx = tok.lastIndexOf(":");
  const utility = colonIdx >= 0 ? tok.slice(colonIdx + 1) : tok;
  // Negation prefix (`-mt-2`) — preserve the leading sign for
  // classification, but drop it for matching.
  const stripped = utility.startsWith("-") ? utility.slice(1) : utility;
  // Arbitrary-value forms always contain `[` — skip them. They route
  // either to Rule 3 (literal hex) or to `var()`/`calc()` which are fine.
  if (stripped.includes("[")) return null;

  if (TAILWIND_COLOR_UTIL_RE.test(stripped)) {
    return { rule: "tailwind-color-utility", label: "Hardcoded Tailwind color utility" };
  }
  if (TAILWIND_SPACING_UTIL_RE.test(stripped)) {
    return { rule: "tailwind-spacing-utility", label: "Hardcoded Tailwind spacing utility" };
  }
  if (TAILWIND_SIZING_UTIL_RE.test(stripped)) {
    return { rule: "tailwind-sizing-utility", label: "Hardcoded Tailwind sizing utility" };
  }
  if (TAILWIND_TYPOGRAPHY_UTIL_RE.test(stripped)) {
    return { rule: "tailwind-typography-utility", label: "Hardcoded Tailwind typography utility" };
  }
  if (TAILWIND_RADIUS_UTIL_RE.test(stripped)) {
    return { rule: "tailwind-radius-utility", label: "Hardcoded Tailwind radius utility" };
  }
  return null;
}
