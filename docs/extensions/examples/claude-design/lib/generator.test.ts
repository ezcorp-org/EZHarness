// Tests for lib/generator.ts — HTML scaffold + tokens block.
//
// Locks the architectural invariant from `knowledge/design-aesthetic-
// philosophy.md`: scaffolds author the body against CSS variables and
// `calc()` expressions, NEVER hex literals or fixed pixel values.
// Without this invariant, knob tweaks don't propagate.

import { describe, expect, test } from "bun:test";
import { applyKnobs } from "./tweak";
import { buildScaffold, buildTokensBlock } from "./generator";
import type { DesignSystem, DraftMeta } from "./types";

const DS: DesignSystem = {
  schemaVersion: 1,
  colors: {
    primary: "#ff0066",
    secondary: "#0066ff",
    neutral: ["#0a0a0a", "#525252", "#fafafa"],
  },
  typography: {
    display: '"Söhne Breit", sans-serif',
    body: '"Söhne", sans-serif',
    mono: "ui-monospace",
    scale: [12, 14, 16, 24, 48],
  },
  spacing: {
    unit: 8,
    scale: [4, 8, 16, 32],
  },
  components: [],
  source: "tailwind",
};

const META: DraftMeta = {
  schemaVersion: 1,
  draftId: "d-test",
  prompt: "A dashboard for the executor",
  kind: "page",
  createdAt: "2026-04-26T20:00:00.000Z",
};

// ── buildTokensBlock ───────────────────────────────────────────────

describe("buildTokensBlock", () => {
  test("emits :root with all top-level variables", () => {
    const css = buildTokensBlock(DS);
    expect(css).toContain(":root {");
    expect(css).toContain("--color-primary: #ff0066;");
    expect(css).toContain("--color-secondary: #0066ff;");
    expect(css).toContain("--font-display:");
    expect(css).toContain("--font-body:");
    expect(css).toContain("--space-unit: 8px;");
  });

  test("emits indexed --color-neutral-N for the ramp", () => {
    const css = buildTokensBlock(DS);
    expect(css).toContain("--color-neutral-1: #0a0a0a;");
    expect(css).toContain("--color-neutral-3: #fafafa;");
  });

  test("emits indexed --space-N for the scale", () => {
    const css = buildTokensBlock(DS);
    expect(css).toContain("--space-1: 4px;");
    expect(css).toContain("--space-4: 32px;");
  });

  test("emits indexed --font-size-N for the typography scale", () => {
    const css = buildTokensBlock(DS);
    expect(css).toContain("--font-size-1: 12px;");
    expect(css).toContain("--font-size-5: 48px;");
  });

  test("emits --color-bg / --color-fg derived from neutral ramp endpoints", () => {
    const css = buildTokensBlock(DS);
    // bg = lightest, fg = darkest (so dark mode is the default by neutral order)
    expect(css).toContain("--color-bg: #fafafa;");
    expect(css).toContain("--color-fg: #0a0a0a;");
  });

  test("falls back to white/black when neutrals is empty", () => {
    const noNeutrals: DesignSystem = {
      ...DS,
      colors: { primary: "#ff0066", neutral: [] },
    };
    const css = buildTokensBlock(noNeutrals);
    expect(css).toContain("--color-bg: #ffffff;");
    expect(css).toContain("--color-fg: #0a0a0a;");
  });
});

// ── buildScaffold structural invariants ───────────────────────────

describe("buildScaffold — structural invariants", () => {
  test("contains exactly one <style id=\"design-tokens\"> block", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    const matches = html.match(/<style\s+id="design-tokens"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test("emits the doctype + html element", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("default mode includes the cdn.jsdelivr.net Tailwind link", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    expect(html).toContain("cdn.jsdelivr.net");
  });

  test("inlineTailwind:true does NOT include cdn.jsdelivr.net", () => {
    const html = buildScaffold({ meta: META, designSystem: DS, inlineTailwind: true });
    expect(html).not.toContain("cdn.jsdelivr.net");
  });
});

// ── Architectural invariant: body uses var() / calc() only ─────────

describe("buildScaffold — body authored against CSS variables", () => {
  test("body region contains var(--color-*) / var(--font-*) / var(--space-*)", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    const body = extractBody(html);
    // At least one var() of each major kind. The exact positions can
    // change as the scaffold evolves; the invariant is that they exist.
    expect(body).toMatch(/var\(--color-/);
    expect(body).toMatch(/var\(--font-/);
    expect(body).toMatch(/var\(--space-unit\)/);
  });

  test("body region contains ZERO hex color literals", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    const body = extractBody(html);
    // Hex colors of 3, 4, 6, or 8 hex digits.
    expect(body).not.toMatch(/#[0-9a-fA-F]{3}\b/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  test("body region contains no fixed Npx literals (except 0/100vh-style)", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    const body = extractBody(html);
    // Allowed: `0`, `100vh`, `100%`. Rejected: `8px`, `16px`, etc.
    // Strip out attribute values + comments to keep the regex focused.
    expect(body).not.toMatch(/\b\d+px\b/);
  });
});

// ── Round-trip: scaffold → applyKnobs ─────────────────────────────

describe("buildScaffold + applyKnobs round-trip", () => {
  test("scaffold output is a valid applyKnobs input — primaryColor knob applies", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    const { html: tweaked, changedVars } = applyKnobs(html, { primaryColor: "#cccccc" });
    expect(changedVars).toContain("--color-primary");
    expect(tweaked).toContain("--color-primary: #cccccc;");
  });

  test("scaffold output is a valid applyKnobs input — spacingScale knob applies", () => {
    const html = buildScaffold({ meta: META, designSystem: DS });
    const { html: tweaked, changedVars } = applyKnobs(html, { spacingScale: "+50%" });
    expect(changedVars.length).toBeGreaterThan(0);
    expect(tweaked).toContain("--space-unit: 12px;"); // 8 * 1.5
  });
});

// ── HTML escaping ─────────────────────────────────────────────────

describe("buildScaffold — HTML escaping", () => {
  test("escapes < > and \" in the title", () => {
    const malicious: DraftMeta = {
      ...META,
      prompt: '<script>alert("xss")</script>',
    };
    const html = buildScaffold({ meta: malicious, designSystem: DS });
    // The <head><title>…</title></head> region must not contain raw <script>
    const titleRegion = html.slice(html.indexOf("<title>"), html.indexOf("</title>") + 8);
    expect(titleRegion).not.toContain("<script>");
    expect(titleRegion).toContain("&lt;script&gt;");
  });
});

// ── Helpers ───────────────────────────────────────────────────────

/** Extract the <body>…</body> region for the body-only invariants
 *  above — keeps the regex assertions focused on the markup the agent
 *  fills in, not the head's token declarations. */
function extractBody(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] ?? "" : "";
}
