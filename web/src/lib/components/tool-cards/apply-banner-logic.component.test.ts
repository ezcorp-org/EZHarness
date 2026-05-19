/**
 * Pure-logic tests for `apply-banner-logic.ts`.
 *
 * Covers the four exports DesignCanvasCard's tweak-design banner +
 * dirty-dot + revision dropdown + tokens diff drawer rely on. These
 * helpers are pure (no Svelte runes, no DOM) so they live in the
 * component-test runner only because the rest of the canvas-card test
 * suite is co-located there.
 *
 * Critical invariants enforced here:
 *
 *   - `summarizeChangedVars` collapses `--space-*` and `--radius-*` into
 *     "N spacing tokens" / "N radius tokens" only when there are 3+ of
 *     either kind. Below the threshold it lists them verbatim.
 *
 *   - `isKnobDirty` reuses `encodeKnobValue` so the dirty calculation
 *     and the POST-body builder NEVER drift apart — meaningful zero,
 *     scale-spacing signed-delta, and empty-skip semantics all stay in
 *     a single source of truth.
 *
 *   - `buildTokensDiffText` returns "" when baseline === current so the
 *     drawer can hide cleanly (no empty diff2html shell rendering).
 */
import { describe, test, expect } from "vitest";
import {
  summarizeChangedVars,
  isKnobDirty,
  formatRevisionLabel,
  buildTokensDiffText,
  type Revision,
} from "./apply-banner-logic";
import type { KnobBodyDescriptor } from "./design-canvas-knob-logic";

// ── summarizeChangedVars ──────────────────────────────────────────

describe("summarizeChangedVars", () => {
  test("empty array → 'no CSS variables changed'", () => {
    expect(summarizeChangedVars([])).toBe("no CSS variables changed");
  });

  test("non-array input (defensive) → 'no CSS variables changed'", () => {
    // @ts-expect-error — testing defensive guard at runtime
    expect(summarizeChangedVars(undefined)).toBe("no CSS variables changed");
    // @ts-expect-error
    expect(summarizeChangedVars(null)).toBe("no CSS variables changed");
  });

  test("single var → 'updated --color-primary'", () => {
    expect(summarizeChangedVars(["--color-primary"])).toBe("updated --color-primary");
  });

  test("two unrelated vars → 'updated a, b'", () => {
    expect(summarizeChangedVars(["--color-primary", "--color-secondary"])).toBe(
      "updated --color-primary, --color-secondary",
    );
  });

  test("two --space-* vars stay listed verbatim (below threshold)", () => {
    expect(summarizeChangedVars(["--space-1", "--space-2"])).toBe(
      "updated --space-1, --space-2",
    );
  });

  test("three --space-* vars collapse to 'N spacing tokens'", () => {
    expect(summarizeChangedVars(["--space-1", "--space-2", "--space-3"])).toBe(
      "updated 3 spacing tokens",
    );
  });

  test("three --radius-* vars collapse to 'N radius tokens'", () => {
    expect(
      summarizeChangedVars(["--radius-base", "--radius-lg", "--radius-xl"]),
    ).toBe("updated 3 radius tokens");
  });

  test("primary + many spacing + one radius — example from spec", () => {
    expect(
      summarizeChangedVars([
        "--color-primary",
        "--space-1",
        "--space-2",
        "--space-3",
        "--space-4",
        "--space-unit",
        "--radius-base",
      ]),
    ).toBe("updated --color-primary, 5 spacing tokens, 1 radius token");
  });

  test("two --radius-* vars stay verbatim (below threshold)", () => {
    expect(summarizeChangedVars(["--radius-base", "--radius-lg"])).toBe(
      "updated --radius-base, --radius-lg",
    );
  });

  // Validation gap-fill: 4+ space vars (no radius/other) collapses; 4+ radius
  // vars (no space/other) collapses; mixed three categories.
  test("4 --space-* vars (no other categories) collapse to 'N spacing tokens'", () => {
    expect(
      summarizeChangedVars(["--space-1", "--space-2", "--space-3", "--space-4"]),
    ).toBe("updated 4 spacing tokens");
  });

  test("4 --radius-* vars (no other categories) collapse to 'N radius tokens'", () => {
    expect(
      summarizeChangedVars([
        "--radius-base",
        "--radius-sm",
        "--radius-lg",
        "--radius-xl",
      ]),
    ).toBe("updated 4 radius tokens");
  });

  test("mixed --color-*, --space-*, --radius-* surfaces other vars verbatim and groups the rest", () => {
    expect(
      summarizeChangedVars([
        "--color-primary",
        "--color-secondary",
        "--space-1",
        "--space-2",
        "--space-3",
        "--radius-base",
        "--radius-lg",
        "--radius-xl",
      ]),
    ).toBe(
      "updated --color-primary, --color-secondary, 3 spacing tokens, 3 radius tokens",
    );
  });
});

// ── isKnobDirty ────────────────────────────────────────────────────

describe("isKnobDirty", () => {
  const colorDesc: KnobBodyDescriptor = { key: "primaryColor", kind: "color" };
  const spacingDesc: KnobBodyDescriptor = {
    key: "spacingScale",
    kind: "range",
    behavior: "scale-spacing",
    unit: "%",
  };
  const radiusDesc: KnobBodyDescriptor = {
    key: "borderRadius",
    kind: "range",
    unit: "px",
  };

  test("empty form + undefined applied → not dirty", () => {
    expect(isKnobDirty(colorDesc, "", undefined)).toBe(false);
  });

  test("empty form + previously-applied value → dirty (user cleared it)", () => {
    expect(isKnobDirty(colorDesc, "", "#ff0066")).toBe(true);
  });

  test("identical color value → not dirty", () => {
    expect(isKnobDirty(colorDesc, "#ff0066", "#ff0066")).toBe(false);
  });

  test("changed color value → dirty", () => {
    expect(isKnobDirty(colorDesc, "#000000", "#ff0066")).toBe(true);
  });

  test("range '0' compared to applied '0px' → not dirty (meaningful zero)", () => {
    expect(isKnobDirty(radiusDesc, "0", "0px")).toBe(false);
  });

  test("range '0' compared to undefined applied → dirty (user dragged from default)", () => {
    expect(isKnobDirty(radiusDesc, "0", undefined)).toBe(true);
  });

  test("scale-spacing slider 30 vs applied '+30%' → not dirty", () => {
    expect(isKnobDirty(spacingDesc, 30, "+30%")).toBe(false);
  });

  test("scale-spacing slider 30 vs applied '+15%' → dirty", () => {
    expect(isKnobDirty(spacingDesc, 30, "+15%")).toBe(true);
  });

  test("scale-spacing slider 0 vs applied '+0%' → not dirty", () => {
    expect(isKnobDirty(spacingDesc, 0, "+0%")).toBe(false);
  });

  // Validation gap-fill: select / text descriptor-kind dirty-state.
  test("select kind: matching value → not dirty; differing → dirty", () => {
    const selectDesc: KnobBodyDescriptor = { key: "density", kind: "select" };
    expect(isKnobDirty(selectDesc, "compact", "compact")).toBe(false);
    expect(isKnobDirty(selectDesc, "spacious", "compact")).toBe(true);
  });

  test("text kind: empty form vs undefined applied → not dirty (no override)", () => {
    const textDesc: KnobBodyDescriptor = { key: "fontBody", kind: "text" };
    expect(isKnobDirty(textDesc, "", undefined)).toBe(false);
  });

  test("text kind: non-empty form vs undefined applied → dirty (user added an override)", () => {
    const textDesc: KnobBodyDescriptor = { key: "fontBody", kind: "text" };
    expect(isKnobDirty(textDesc, "Inter", undefined)).toBe(true);
  });

  test("text kind: identical non-empty form → not dirty", () => {
    const textDesc: KnobBodyDescriptor = { key: "fontBody", kind: "text" };
    expect(isKnobDirty(textDesc, "Inter", "Inter")).toBe(false);
  });

  // Color values are NOT canonicalized — the helper relies on raw string
  // equality. `#fff` and `#ffffff` represent the same color but are
  // different strings, so the dirty check returns true. Lock the actual
  // implementation behavior so future refactors don't silently change it.
  test("color: #fff vs applied #ffffff → DIRTY (no canonicalization)", () => {
    const colorDesc: KnobBodyDescriptor = { key: "primaryColor", kind: "color" };
    expect(isKnobDirty(colorDesc, "#fff", "#ffffff")).toBe(true);
  });

  test("color: identical hex strings → not dirty", () => {
    const colorDesc: KnobBodyDescriptor = { key: "primaryColor", kind: "color" };
    expect(isKnobDirty(colorDesc, "#ffffff", "#ffffff")).toBe(false);
  });
});

// ── formatRevisionLabel ────────────────────────────────────────────

describe("formatRevisionLabel", () => {
  function rev(overrides: Partial<Revision> = {}): Revision {
    return {
      revisionId: "r-1",
      parentDraftId: "p-1",
      knobValues: {},
      createdAt: "2026-04-27T12:43:08.000Z",
      isOriginal: false,
      ...overrides,
    };
  }

  test("isOriginal → '<time> — original'", () => {
    expect(formatRevisionLabel(rev({ isOriginal: true }))).toBe(
      "12:43:08 — original",
    );
  });

  test("no overrides on a non-original revision → 'no overrides' tail", () => {
    expect(formatRevisionLabel(rev())).toBe("12:43:08 — no overrides");
  });

  test("up to 3 keys are listed verbatim", () => {
    expect(
      formatRevisionLabel(
        rev({
          knobValues: {
            primaryColor: "#ff0066",
            spacing: "+15%",
            density: "compact",
          },
        }),
      ),
    ).toBe("12:43:08 — primaryColor=#ff0066, spacing=+15%, density=compact");
  });

  test("more than 3 keys appends '(+N more)'", () => {
    expect(
      formatRevisionLabel(
        rev({
          knobValues: {
            a: "1",
            b: "2",
            c: "3",
            d: "4",
            e: "5",
          },
        }),
      ),
    ).toBe("12:43:08 — a=1, b=2, c=3 (+2 more)");
  });

  test("values past 12 chars truncate with ellipsis", () => {
    expect(
      formatRevisionLabel(
        rev({
          knobValues: {
            headline: "A very very very long headline value",
          },
        }),
      ),
    ).toBe("12:43:08 — headline=A very very…");
  });

  test("malformed createdAt falls back to the raw string", () => {
    expect(
      formatRevisionLabel(
        rev({
          createdAt: "not-a-date",
          knobValues: { x: "y" },
        }),
      ),
    ).toBe("not-a-date — x=y");
  });

  // Gap-fill: 1 key with no truncation, 6 keys (boundary above MAX_KEYS).
  test("exactly 1 key renders verbatim with no '+N more' suffix", () => {
    expect(
      formatRevisionLabel(rev({ knobValues: { primaryColor: "#ff0066" } })),
    ).toBe("12:43:08 — primaryColor=#ff0066");
  });

  test("6 keys → first 3 + '(+3 more)'", () => {
    expect(
      formatRevisionLabel(
        rev({
          knobValues: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" },
        }),
      ),
    ).toBe("12:43:08 — a=1, b=2, c=3 (+3 more)");
  });
});

// ── buildTokensDiffText ────────────────────────────────────────────

describe("buildTokensDiffText", () => {
  test("equal baseline + current → '' (drawer hides cleanly)", () => {
    expect(buildTokensDiffText("--color: red", "--color: red")).toBe("");
  });

  test("simple single-line diff includes header + minus/plus lines", () => {
    const out = buildTokensDiffText("--color: red", "--color: blue");
    expect(out).toContain("--- a/design-tokens");
    expect(out).toContain("+++ b/design-tokens");
    expect(out).toContain("@@ -1,1 +1,1 @@");
    expect(out).toContain("---color: red");
    expect(out).toContain("+--color: blue");
  });

  test("multi-line diff renders both sides in full", () => {
    const baseline = "--a: 1\n--b: 2";
    const current = "--a: 1\n--b: 3\n--c: 4";
    const out = buildTokensDiffText(baseline, current);
    expect(out).toContain("@@ -1,2 +1,3 @@");
    // Every baseline line is prefixed with `-`.
    expect(out).toContain("---a: 1");
    expect(out).toContain("---b: 2");
    // Every current line is prefixed with `+`.
    expect(out).toContain("+--a: 1");
    expect(out).toContain("+--b: 3");
    expect(out).toContain("+--c: 4");
  });

  test("empty baseline + non-empty current still produces a diff", () => {
    const out = buildTokensDiffText("", "--color: red");
    // Empty baseline splits to [""] (one empty line) — that's the
    // expected behavior of String.split. The hunk header reflects it.
    expect(out).toContain("@@ -1,1 +1,1 @@");
    expect(out).toContain("+--color: red");
  });

  // Gap-fill: confirm the synthesized diff string is consumable by
  // diff2html — i.e. its parser yields >=1 file entry. This pins the
  // contract DesignCanvasCard relies on when rendering the drawer.
  test("output of differing inputs parses into >=1 diff2html file entry", async () => {
    const Diff2Html = await import("diff2html");
    const baseline = ":root {\n  --color-primary: red;\n}";
    const current = ":root {\n  --color-primary: blue;\n}";
    const out = buildTokensDiffText(baseline, current);
    const parsed = Diff2Html.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
  });

  test("identical inputs produce '' (parser would treat it as no-op)", () => {
    expect(buildTokensDiffText("--a:1", "--a:1")).toBe("");
  });
});
