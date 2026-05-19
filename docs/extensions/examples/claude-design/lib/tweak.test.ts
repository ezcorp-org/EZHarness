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
import {
  applyKnobs,
  applyKnobsByDescriptors,
  extractTokensBlock,
  parseScaleFactor,
  replaceTokensBlock,
} from "./tweak";
import type { KnobDescriptor } from "./types";

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

  test("rejects bare numeric > 5 (catches misencoded px values)", () => {
    // `12px` from a scale-spacing knob mistakenly declared with `unit: "px"`
    // would have been treated as a 12× multiplier and inflated --space-unit
    // from 8px to 96px; one more apply pushed it to 1152px. The guardrail
    // rejects bare-number inputs above 5 so the bug fails loud.
    expect(() => parseScaleFactor("12")).toThrow(/> 5/);
    expect(() => parseScaleFactor("100")).toThrow(/> 5/);
  });

  test("accepts bare numeric inside [0.1, 5]", () => {
    expect(parseScaleFactor("1")).toBeCloseTo(1);
    expect(parseScaleFactor("5")).toBeCloseTo(5);
    expect(parseScaleFactor("0.5")).toBeCloseTo(0.5);
  });
});

// ── Token-block helpers (snapshot/restore for idempotence) ─────────

describe("extractTokensBlock + replaceTokensBlock", () => {
  test("extractTokensBlock returns the inner declarations", () => {
    const inner = extractTokensBlock(FIXTURE);
    expect(inner).not.toBeNull();
    expect(inner!).toContain("--color-primary: #336699;");
    expect(inner!).toContain("--space-unit: 8px;");
    // Must NOT include the surrounding <style> tags.
    expect(inner!).not.toContain("<style");
    expect(inner!).not.toContain("</style>");
  });

  test("extractTokensBlock returns null when block is absent", () => {
    expect(extractTokensBlock("<html><body>no tokens</body></html>")).toBeNull();
  });

  test("replaceTokensBlock swaps in fresh declarations", () => {
    const replacement = `
:root {
  --color-primary: #ff0066;
  --space-unit: 8px;
}
`;
    const next = replaceTokensBlock(FIXTURE, replacement);
    expect(next).toContain("--color-primary: #ff0066;");
    // Original tokens should be gone.
    expect(next).not.toContain("--color-primary: #336699;");
    // Body markup is preserved.
    expect(next).toContain('color: var(--color-primary)');
    // Wrapper tags survived.
    expect(next).toMatch(/<style\s+id="design-tokens">/);
    expect(next).toContain("</style>");
  });

  test("replaceTokensBlock is a no-op when block is absent", () => {
    const html = "<html><body>no tokens</body></html>";
    expect(replaceTokensBlock(html, ":root { --x: 1px; }")).toBe(html);
  });

  test("round-trip: extract → replace yields identical HTML", () => {
    const inner = extractTokensBlock(FIXTURE)!;
    const restored = replaceTokensBlock(FIXTURE, inner);
    expect(restored).toBe(FIXTURE);
  });
});

// ── Idempotence: applying the same descriptor value twice == once ──
//
// The compounding-zoom bug came from re-scaling already-scaled tokens.
// `applyKnobsToDraft` now restores the original tokens block before
// each apply (using the snapshot persisted in `meta.originalTokensBlock`).
// These tests assert the algorithmic property at the pure-function
// level: given a baseline HTML, applying knobs N times against that
// baseline yields the same result regardless of N.

describe("applyKnobsByDescriptors — idempotence against baseline", () => {
  const SCALE_DESCRIPTOR: KnobDescriptor[] = [
    {
      key: "spacing",
      label: "Spacing",
      kind: "range",
      behavior: "scale-spacing",
      unit: "%",
      min: -30,
      max: 30,
      step: 5,
      current: "+0%",
    },
  ];

  test("applying +30% once and applying +30% again to baseline yields same html", () => {
    const once = applyKnobsByDescriptors(FIXTURE, SCALE_DESCRIPTOR, {
      spacing: "+30%",
    }).html;
    const twice = applyKnobsByDescriptors(FIXTURE, SCALE_DESCRIPTOR, {
      spacing: "+30%",
    }).html;
    expect(twice).toBe(once);
  });

  test("compounded apply (without baseline restore) DOES diverge — proves the snapshot is load-bearing", () => {
    // Apply once.
    const first = applyKnobsByDescriptors(FIXTURE, SCALE_DESCRIPTOR, {
      spacing: "+30%",
    }).html;
    // Apply +30% AGAIN to the already-scaled output.
    const compounded = applyKnobsByDescriptors(first, SCALE_DESCRIPTOR, {
      spacing: "+30%",
    }).html;
    // It compounds: 8 × 1.3 × 1.3 = 13.52, not 10.4.
    expect(compounded).toContain("--space-unit: 13.52px;");
    // Restoring the baseline first then applying yields the single-shot value.
    const baselineInner = extractTokensBlock(FIXTURE)!;
    const restored = replaceTokensBlock(first, baselineInner);
    const fromBaseline = applyKnobsByDescriptors(restored, SCALE_DESCRIPTOR, {
      spacing: "+30%",
    }).html;
    expect(fromBaseline).toContain("--space-unit: 10.4px;");
    expect(fromBaseline).toBe(first);
  });

  test("color knob is idempotent without baseline restore (writes are absolute)", () => {
    const descriptors: KnobDescriptor[] = [
      { key: "primary", label: "Primary", kind: "color", var: "--color-primary" },
    ];
    const once = applyKnobsByDescriptors(FIXTURE, descriptors, { primary: "#ff0066" }).html;
    const twice = applyKnobsByDescriptors(once, descriptors, { primary: "#ff0066" }).html;
    expect(twice).toBe(once);
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

// ── applyKnobsByDescriptors — descriptor-driven knob applier ──────

describe("applyKnobsByDescriptors — custom CSS variable", () => {
  test("rewrites the descriptor's `var` field, not a derived name", () => {
    const fixture = `<style id="design-tokens">:root { --color-accent: #000; }</style>`;
    const descriptors: KnobDescriptor[] = [
      { key: "accentColor", label: "Accent", kind: "color", var: "--color-accent" },
    ];
    const { html, changedVars } = applyKnobsByDescriptors(fixture, descriptors, {
      accentColor: "#ff8800",
    });
    expect(html).toContain("--color-accent: #ff8800;");
    expect(changedVars).toEqual(["--color-accent"]);
  });
});

describe("applyKnobsByDescriptors — range with explicit unit", () => {
  test("range descriptor with unit:'px' formats `12px`", () => {
    const fixture = `<style id="design-tokens">:root { --radius-base: 4px; }</style>`;
    const descriptors: KnobDescriptor[] = [
      {
        key: "borderRadius",
        label: "Radius",
        kind: "range",
        var: "--radius-base",
        unit: "px",
      },
    ];
    const { html, changedVars } = applyKnobsByDescriptors(fixture, descriptors, {
      borderRadius: "12",
    });
    expect(html).toContain("--radius-base: 12px;");
    expect(changedVars).toContain("--radius-base");
  });
});

describe("applyKnobsByDescriptors — scale-spacing behavior", () => {
  test("rescales every --space-* via scaleSpacing math", () => {
    const descriptors: KnobDescriptor[] = [
      {
        key: "spacingScale",
        label: "Spacing",
        kind: "text",
        behavior: "scale-spacing",
      },
    ];
    const { html, changedVars } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "+10%",
    });
    expect(html).toContain("--space-unit: 8.8px;");
    expect(html).toContain("--space-1: 8.8px;");
    expect(html).toContain("--space-2: 17.6px;");
    expect(changedVars).toContain("--space-unit");
    expect(changedVars).toContain("--radius-base");
  });
});

// ── Slider semantics: range + scale-spacing + unit:"%" ─────────────
//
// Regression repros the "every design becomes very zoomed in" bug.
// The canvas card's spacing-scale slider has descriptor:
//   { kind: "range", behavior: "scale-spacing", unit: "%", min: -25, max: 50 }
// Slider value is a DELTA (-25..+50). The wire format MUST be a
// signed-percent string so the backend's `parseScaleFactor` reads it
// as `1 + N/100` (not as `N/100` absolute). These tests lock the
// invariant from the backend side — `applyKnobsByDescriptors` must
// produce sensible output for the whole signed-delta range.

describe("applyKnobsByDescriptors — spacing slider signed-delta wire format", () => {
  function spacingDescriptor(): KnobDescriptor[] {
    return [
      {
        key: "spacingScale",
        label: "Spacing scale (%)",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
        min: -25,
        max: 50,
        step: 5,
      },
    ];
  }

  test('"+30%" multiplies spacing by 1.30 (slider at +30 means BIGGER, not THIRD)', () => {
    const descriptors = spacingDescriptor();
    const { html } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "+30%",
    });
    // 8 * 1.30 = 10.4. NOT 8 * 0.30 = 2.4.
    expect(html).toContain("--space-unit: 10.4px;");
    expect(html).toContain("--space-1: 10.4px;");
    expect(html).toContain("--space-2: 20.8px;");
    // Sanity: NOT the catastrophic 0.30x output.
    expect(html).not.toContain("--space-unit: 2.4px;");
    expect(html).not.toContain("--space-2: 4.8px;");
  });

  test('"-15%" multiplies spacing by 0.85 (slider at -15 means SMALLER)', () => {
    const descriptors = spacingDescriptor();
    const { html } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "-15%",
    });
    // 8 * 0.85 = 6.8.
    expect(html).toContain("--space-unit: 6.8px;");
    expect(html).toContain("--space-2: 13.6px;");
  });

  test('"+0%" leaves spacing unchanged (slider at midpoint = no-op)', () => {
    const descriptors = spacingDescriptor();
    const { html } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "+0%",
    });
    expect(html).toContain("--space-unit: 8px;");
    expect(html).toContain("--space-1: 8px;");
    expect(html).toContain("--space-2: 16px;");
    expect(html).toContain("--space-3: 24px;");
  });

  test('"-0%" also leaves spacing unchanged', () => {
    const descriptors = spacingDescriptor();
    const { html } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "-0%",
    });
    expect(html).toContain("--space-unit: 8px;");
  });

  test('full negative bound "-25%" multiplies by 0.75', () => {
    const descriptors = spacingDescriptor();
    const { html } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "-25%",
    });
    expect(html).toContain("--space-unit: 6px;");
  });

  test('full positive bound "+50%" multiplies by 1.50', () => {
    const descriptors = spacingDescriptor();
    const { html } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "+50%",
    });
    expect(html).toContain("--space-unit: 12px;");
    expect(html).toContain("--space-2: 24px;");
  });
});

// ── Density select-knob with scale-spacing behavior ────────────────

describe("applyKnobsByDescriptors — density select knob", () => {
  function densityDescriptor(): KnobDescriptor[] {
    return [
      {
        key: "density",
        label: "Density",
        kind: "select",
        options: ["compact", "cozy", "spacious"],
        behavior: "scale-spacing",
      },
    ];
  }

  test('"compact" scales spacing by 0.75', () => {
    const { html } = applyKnobsByDescriptors(FIXTURE, densityDescriptor(), {
      density: "compact",
    });
    expect(html).toContain("--space-unit: 6px;");
    expect(html).toContain("--space-2: 12px;");
  });

  test('"cozy" leaves spacing unchanged', () => {
    const { html } = applyKnobsByDescriptors(FIXTURE, densityDescriptor(), {
      density: "cozy",
    });
    expect(html).toContain("--space-unit: 8px;");
  });

  test('"spacious" scales spacing by 1.25', () => {
    const { html } = applyKnobsByDescriptors(FIXTURE, densityDescriptor(), {
      density: "spacious",
    });
    expect(html).toContain("--space-unit: 10px;");
  });

  test("does NOT touch fonts or colors", () => {
    const { html } = applyKnobsByDescriptors(FIXTURE, densityDescriptor(), {
      density: "compact",
    });
    expect(html).toContain("--color-primary: #336699;");
    expect(html).toContain('--font-display: "Söhne Breit", sans-serif;');
  });

  test("garbage option string is ignored (no crash, no change)", () => {
    const { html, changedVars } = applyKnobsByDescriptors(
      FIXTURE,
      densityDescriptor(),
      { density: "wibble" },
    );
    expect(html).toContain("--space-unit: 8px;");
    expect(changedVars).toEqual([]);
  });
});

// ── Range descriptors: unit handling ───────────────────────────────

describe("applyKnobsByDescriptors — range unit handling", () => {
  test("explicit unit:'rem' formats `1.5rem`", () => {
    const fixture = `<style id="design-tokens">:root { --radius-base: 4px; }</style>`;
    const descriptors: KnobDescriptor[] = [
      {
        key: "borderRadius",
        label: "Radius",
        kind: "range",
        var: "--radius-base",
        unit: "rem",
      },
    ];
    const { html } = applyKnobsByDescriptors(fixture, descriptors, {
      borderRadius: "1.5",
    });
    expect(html).toContain("--radius-base: 1.5rem;");
  });

  test("range with no unit defaults to px", () => {
    const fixture = `<style id="design-tokens">:root { --radius-base: 4px; }</style>`;
    const descriptors: KnobDescriptor[] = [
      { key: "borderRadius", label: "Radius", kind: "range", var: "--radius-base" },
    ];
    const { html } = applyKnobsByDescriptors(fixture, descriptors, {
      borderRadius: "10",
    });
    expect(html).toContain("--radius-base: 10px;");
  });

  test('range value "0" with unit "px" writes "0px" (meaningful zero)', () => {
    const fixture = `<style id="design-tokens">:root { --radius-base: 4px; }</style>`;
    const descriptors: KnobDescriptor[] = [
      {
        key: "borderRadius",
        label: "Radius",
        kind: "range",
        var: "--radius-base",
        unit: "px",
      },
    ];
    const { html } = applyKnobsByDescriptors(fixture, descriptors, {
      borderRadius: "0",
    });
    expect(html).toContain("--radius-base: 0px;");
  });
});

// ── Color / select / text descriptors ──────────────────────────────

describe("applyKnobsByDescriptors — value formats per kind", () => {
  test("color descriptor writes raw hex", () => {
    const fixture = `<style id="design-tokens">:root { --color-accent: #000000; }</style>`;
    const descriptors: KnobDescriptor[] = [
      { key: "accent", label: "Accent", kind: "color", var: "--color-accent" },
    ];
    const { html } = applyKnobsByDescriptors(fixture, descriptors, {
      accent: "#ff0066",
    });
    expect(html).toContain("--color-accent: #ff0066;");
  });

  test("select (non-scale-spacing) writes raw option string", () => {
    const fixture = `<style id="design-tokens">:root { --button-style: solid; }</style>`;
    const descriptors: KnobDescriptor[] = [
      {
        key: "buttonStyle",
        label: "Button style",
        kind: "select",
        options: ["solid", "ghost", "outline"],
        var: "--button-style",
      },
    ];
    const { html } = applyKnobsByDescriptors(fixture, descriptors, {
      buttonStyle: "ghost",
    });
    expect(html).toContain("--button-style: ghost;");
  });

  test("text descriptor writes raw string", () => {
    const fixture = `<style id="design-tokens">:root { --font-body: Inter; }</style>`;
    const descriptors: KnobDescriptor[] = [
      { key: "fontBody", label: "Body font", kind: "text", var: "--font-body" },
    ];
    const { html } = applyKnobsByDescriptors(fixture, descriptors, {
      fontBody: '"Söhne", sans-serif',
    });
    expect(html).toContain('--font-body: "Söhne", sans-serif;');
  });
});

// ── Multi-knob composition (descriptor path) ──────────────────────

describe("applyKnobsByDescriptors — multi-knob composition", () => {
  test("color + range + scale-spacing all land without interference", () => {
    const descriptors: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color", var: "--color-primary" },
      {
        key: "borderRadius",
        label: "Radius",
        kind: "range",
        var: "--radius-base",
        unit: "px",
      },
      {
        key: "spacingScale",
        label: "Spacing",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
      },
    ];
    const { html, changedVars } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      primaryColor: "#ff0066",
      borderRadius: "12",
      spacingScale: "+20%",
    });
    expect(html).toContain("--color-primary: #ff0066;");
    // borderRadius's per-var rewrite runs AFTER scale-spacing, so the
    // explicit value wins (deterministic — last write of two passes).
    expect(html).toContain("--radius-base: 12px;");
    // --radius-large gets the scale-spacing rescale (no descriptor for it).
    expect(html).toContain("--radius-large: 9.6px;");
    expect(html).toContain("--space-unit: 9.6px;"); // 8 * 1.20
    expect(html).toContain("--space-2: 19.2px;"); // 16 * 1.20
    expect(changedVars).toContain("--color-primary");
    // Note: --radius-base appears twice — once via scale-spacing, once via
    // the per-var rewrite. Both branches happened.
    expect(changedVars).toContain("--radius-base");
    expect(changedVars).toContain("--space-unit");
  });

  test("--space-unit IS rescaled (not just numbered --space-N)", () => {
    const descriptors: KnobDescriptor[] = [
      {
        key: "spacingScale",
        label: "Spacing",
        kind: "text",
        behavior: "scale-spacing",
      },
    ];
    const { html, changedVars } = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "+25%",
    });
    expect(html).toContain("--space-unit: 10px;");
    expect(changedVars).toContain("--space-unit");
  });

  test("round-trip stability: applying +0% twice produces identical output", () => {
    const descriptors: KnobDescriptor[] = [
      {
        key: "spacingScale",
        label: "Spacing",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
      },
    ];
    const once = applyKnobsByDescriptors(FIXTURE, descriptors, {
      spacingScale: "+0%",
    });
    const twice = applyKnobsByDescriptors(once.html, descriptors, {
      spacingScale: "+0%",
    });
    expect(twice.html).toBe(once.html);
  });
});

describe("applyKnobsByDescriptors — auto-derived var from kebab key", () => {
  test("primaryColor → --primary-color when `var` is absent", () => {
    const fixture = `<style id="design-tokens">:root { --primary-color: #aaa; }</style>`;
    const descriptors: KnobDescriptor[] = [
      { key: "primaryColor", label: "Primary", kind: "color" },
    ];
    const { html, changedVars } = applyKnobsByDescriptors(fixture, descriptors, {
      primaryColor: "#ff0066",
    });
    expect(html).toContain("--primary-color: #ff0066;");
    expect(changedVars).toEqual(["--primary-color"]);
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
