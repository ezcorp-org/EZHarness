// Tests for lib/tweak.ts — the load-bearing CSS-variable transform.
//
// Locks down:
//   - primaryColor / secondaryColor / borderRadius rewrites only the
//     targeted CSS variable, leaving the rest of the block (and the
//     entire body) untouched.
//   - spacingScale parses +N% / -N% / N% / bare-number formats.
//   - density compact/cozy/spacious applies the documented factors.
//   - Missing token block throws (the architectural invariant).
//   - Variables not in the block are silently no-op (don't throw).

import { describe, expect, test } from "bun:test";
import { applyKnobs, parseScaleFactor } from "./tweak";

const FIXTURE = `<!doctype html>
<html>
<head>
<style id="design-tokens">
:root {
  --color-primary: #336699;
  --color-secondary: #99cc33;
  --space-unit: 8px;
  --space-1: 8px;
  --space-2: 16px;
  --space-3: 24px;
  --radius-base: 4px;
  --radius-large: 8px;
  --font-display: "Söhne Breit", sans-serif;
}
</style>
</head>
<body>
<div style="color: var(--color-primary); padding: calc(var(--space-unit) * 2)">
  Hello
</div>
</body>
</html>`;

// ── Color knobs ────────────────────────────────────────────────────

describe("applyKnobs — primaryColor", () => {
  test("replaces only --color-primary", () => {
    const { html, changedVars } = applyKnobs(FIXTURE, { primaryColor: "#ff0066" });
    expect(html).toContain("--color-primary: #ff0066;");
    expect(html).toContain("--color-secondary: #99cc33;"); // untouched
    expect(changedVars).toEqual(["--color-primary"]);
  });

  test("preserves body markup verbatim", () => {
    const { html } = applyKnobs(FIXTURE, { primaryColor: "#ff0066" });
    expect(html).toContain('<div style="color: var(--color-primary); padding: calc(var(--space-unit) * 2)">');
    expect(html).toContain("Hello");
  });

  test("non-existent variable in token block → silent no-op", () => {
    const tiny = `<style id="design-tokens">:root { --x: 1; }</style>`;
    const { changedVars } = applyKnobs(tiny, { primaryColor: "#ff0066" });
    expect(changedVars).toEqual([]);
  });

  test("returns full HTML, not just the block", () => {
    const { html } = applyKnobs(FIXTURE, { primaryColor: "#ff0066" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });
});

describe("applyKnobs — secondaryColor", () => {
  test("replaces --color-secondary independently of primary", () => {
    const { html, changedVars } = applyKnobs(FIXTURE, { secondaryColor: "#333333" });
    expect(html).toContain("--color-primary: #336699;"); // untouched
    expect(html).toContain("--color-secondary: #333333;");
    expect(changedVars).toEqual(["--color-secondary"]);
  });
});

// ── borderRadius ───────────────────────────────────────────────────

describe("applyKnobs — borderRadius", () => {
  test("bare number is interpreted as px", () => {
    const { html } = applyKnobs(FIXTURE, { borderRadius: "0" });
    expect(html).toContain("--radius-base: 0px;");
  });

  test("explicit unit passes through", () => {
    const { html } = applyKnobs(FIXTURE, { borderRadius: "1rem" });
    expect(html).toContain("--radius-base: 1rem;");
  });

  test("does NOT touch --radius-large (only base)", () => {
    const { html } = applyKnobs(FIXTURE, { borderRadius: "0" });
    expect(html).toContain("--radius-large: 8px;");
  });
});

// ── spacingScale ──────────────────────────────────────────────────

describe("applyKnobs — spacingScale", () => {
  test('"+10%" multiplies every --space-* by 1.1', () => {
    const { html, changedVars } = applyKnobs(FIXTURE, { spacingScale: "+10%" });
    expect(html).toContain("--space-unit: 8.8px;");
    expect(html).toContain("--space-1: 8.8px;");
    expect(html).toContain("--space-2: 17.6px;");
    expect(html).toContain("--space-3: 26.4px;");
    // ALSO scales --radius-* (intentional — radii follow the spacing rhythm)
    expect(changedVars).toContain("--space-unit");
    expect(changedVars).toContain("--space-1");
    expect(changedVars).toContain("--radius-base");
  });

  test('"-25%" multiplies by 0.75', () => {
    const { html } = applyKnobs(FIXTURE, { spacingScale: "-25%" });
    expect(html).toContain("--space-unit: 6px;");
    expect(html).toContain("--space-2: 12px;");
  });

  test('"150%" treats absolute percentage as multiplier (1.5)', () => {
    const { html } = applyKnobs(FIXTURE, { spacingScale: "150%" });
    expect(html).toContain("--space-unit: 12px;");
  });

  test('"1.5" bare numeric treated as multiplier', () => {
    const { html } = applyKnobs(FIXTURE, { spacingScale: "1.5" });
    expect(html).toContain("--space-unit: 12px;");
  });

  test("does NOT scale --color-* or --font-*", () => {
    const { html } = applyKnobs(FIXTURE, { spacingScale: "+50%" });
    expect(html).toContain("--color-primary: #336699;");
    expect(html).toContain('--font-display: "Söhne Breit", sans-serif;');
  });
});

// ── density ───────────────────────────────────────────────────────

describe("applyKnobs — density", () => {
  test("compact (0.75x)", () => {
    const { html } = applyKnobs(FIXTURE, { density: "compact" });
    expect(html).toContain("--space-unit: 6px;");
  });

  test("cozy (1x — no-op)", () => {
    const { html } = applyKnobs(FIXTURE, { density: "cozy" });
    expect(html).toContain("--space-unit: 8px;");
  });

  test("spacious (1.25x)", () => {
    const { html } = applyKnobs(FIXTURE, { density: "spacious" });
    expect(html).toContain("--space-unit: 10px;");
  });
});

// ── Architectural invariant ────────────────────────────────────────

describe("applyKnobs — missing token block", () => {
  test("throws when no <style id=\"design-tokens\"> block exists", () => {
    const noBlock = "<html><body>nothing</body></html>";
    expect(() => applyKnobs(noBlock, { primaryColor: "#ff0066" })).toThrow(
      /does not contain a/,
    );
  });

  test("throws when block has wrong id", () => {
    const wrongId = `<style id="other">:root { --color-primary: red; }</style>`;
    expect(() => applyKnobs(wrongId, { primaryColor: "#ff0066" })).toThrow();
  });
});

// ── parseScaleFactor (exported for test isolation) ─────────────────

describe("parseScaleFactor", () => {
  test("accepts +N%", () => {
    expect(parseScaleFactor("+10%")).toBeCloseTo(1.1);
    expect(parseScaleFactor("+0%")).toBeCloseTo(1);
  });

  test("accepts -N%", () => {
    expect(parseScaleFactor("-25%")).toBeCloseTo(0.75);
  });

  test("accepts absolute N%", () => {
    expect(parseScaleFactor("150%")).toBeCloseTo(1.5);
    expect(parseScaleFactor("100%")).toBeCloseTo(1);
  });

  test("accepts bare numeric multiplier", () => {
    expect(parseScaleFactor("1.5")).toBeCloseTo(1.5);
    expect(parseScaleFactor("0.5")).toBeCloseTo(0.5);
  });

  test("rejects garbage", () => {
    expect(() => parseScaleFactor("nope")).toThrow();
    expect(() => parseScaleFactor("")).toThrow();
    expect(() => parseScaleFactor("0")).toThrow();
    expect(() => parseScaleFactor("-1")).toThrow();
  });
});

// ── Multi-knob composition ─────────────────────────────────────────

describe("applyKnobs — multi-knob composition", () => {
  test("color + spacing knobs both apply in one call", () => {
    const { html, changedVars } = applyKnobs(FIXTURE, {
      primaryColor: "#ff0066",
      spacingScale: "+10%",
    });
    expect(html).toContain("--color-primary: #ff0066;");
    expect(html).toContain("--space-unit: 8.8px;");
    expect(changedVars).toContain("--color-primary");
    expect(changedVars).toContain("--space-unit");
  });

  test("empty knobs object produces no changes", () => {
    const { html, changedVars } = applyKnobs(FIXTURE, {});
    expect(html).toBe(FIXTURE);
    expect(changedVars).toEqual([]);
  });
});

// ── Iframe-stability regression: parent file gets overwritten ─────
//
// The canvas iframe URL points at `<parentDraftId>.html`. Without
// also writing the post-tweak HTML to the parent path, the iframe
// reload after a knob-change shows the pre-tweak design and the user
// sees no change. This test mirrors the index.ts dispatcher's
// `applyKnobsToDraft` post-tweak file write — both the new
// `<parentId>__r<ts>.html` revision file AND the parent `<parentId>.html`
// must contain the new CSS-variable values. Locks the contract that
// `iframeBustTick`-driven reloads in DesignCanvasCard see fresh content.

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("dispatcher contract: applyKnobs result is written to BOTH the new revision AND the parent path", () => {
  test("after applyKnobs, persisting to both paths leaves matching content", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-design-tweak-"));
    try {
      const parentId = "d-parent";
      const parentHtmlPath = join(dir, `${parentId}.html`);
      writeFileSync(parentHtmlPath, FIXTURE);

      // Simulate the dispatcher path:
      const html = readFileSync(parentHtmlPath, "utf-8");
      const { html: nextHtml, changedVars } = applyKnobs(html, { primaryColor: "#ff0066" });

      // 1) Write new revision (revision history preservation).
      const revisionId = `${parentId}__r123abc`;
      const revisionPath = join(dir, `${revisionId}.html`);
      writeFileSync(revisionPath, nextHtml);

      // 2) Overwrite the parent (iframe URL stability).
      writeFileSync(parentHtmlPath, nextHtml);

      // Both files now show the new tokens — that's the contract.
      expect(existsSync(revisionPath)).toBe(true);
      expect(existsSync(parentHtmlPath)).toBe(true);
      const revisionContents = readFileSync(revisionPath, "utf-8");
      const parentContents = readFileSync(parentHtmlPath, "utf-8");
      expect(revisionContents).toContain("--color-primary: #ff0066;");
      expect(parentContents).toContain("--color-primary: #ff0066;");
      expect(parentContents).not.toContain("--color-primary: #336699;");
      expect(changedVars).toContain("--color-primary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
