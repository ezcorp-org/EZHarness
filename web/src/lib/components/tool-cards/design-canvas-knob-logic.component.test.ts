/**
 * Pure-logic tests for `design-canvas-knob-logic.ts`.
 *
 * Covers `buildKnobBody` / `encodeKnobValue` — the function that
 * translates the canvas card's form-state values map into the wire
 * shape the `claude-design:knob-change` route expects. The
 * load-bearing invariant is the signed-delta percent encoding for
 * scale-spacing range knobs:
 *
 *   slider value  3 0   →  wire   "+30%"   →  factor  1.30
 *   slider value -15    →  wire   "-15%"   →  factor  0.85
 *   slider value   0    →  wire   "+0%"    →  factor  1.00
 *
 * Without the sign on positive values, backend's `parseScaleFactor`
 * reads "30%" as the absolute branch (0.30), every spacing token
 * shrinks to a third of its base, and the rendered design crowds into
 * itself ("very zoomed in"). This module is the canary.
 */
import { describe, test, expect } from "vitest";
import {
  buildKnobBody,
  encodeKnobValue,
  type KnobBodyDescriptor,
} from "./design-canvas-knob-logic";

// ── encodeKnobValue ───────────────────────────────────────────────

describe("encodeKnobValue — range with scale-spacing + unit:%", () => {
  const desc: KnobBodyDescriptor = {
    key: "spacingScale",
    kind: "range",
    behavior: "scale-spacing",
    unit: "%",
  };

  test("positive value gets + sign", () => {
    expect(encodeKnobValue(desc, 30)).toBe("+30%");
    expect(encodeKnobValue(desc, "30")).toBe("+30%");
  });

  test("negative value keeps - sign", () => {
    expect(encodeKnobValue(desc, -15)).toBe("-15%");
    expect(encodeKnobValue(desc, "-15")).toBe("-15%");
  });

  test("zero is signed (+0%) and considered meaningful", () => {
    expect(encodeKnobValue(desc, 0)).toBe("+0%");
    expect(encodeKnobValue(desc, "0")).toBe("+0%");
  });

  test("range bound -25 (compact end of slider)", () => {
    expect(encodeKnobValue(desc, -25)).toBe("-25%");
  });

  test("range bound +50 (spacious end of slider)", () => {
    expect(encodeKnobValue(desc, 50)).toBe("+50%");
  });
});

describe("encodeKnobValue — range without scale-spacing behavior", () => {
  test("range with unit:'px' appends px", () => {
    const desc: KnobBodyDescriptor = {
      key: "borderRadius",
      kind: "range",
      unit: "px",
    };
    expect(encodeKnobValue(desc, 12)).toBe("12px");
    expect(encodeKnobValue(desc, "12")).toBe("12px");
  });

  test("range with value 0 + unit:'px' yields '0px' (meaningful zero, not skipped)", () => {
    const desc: KnobBodyDescriptor = {
      key: "borderRadius",
      kind: "range",
      unit: "px",
    };
    expect(encodeKnobValue(desc, 0)).toBe("0px");
    expect(encodeKnobValue(desc, "0")).toBe("0px");
  });

  test("range with unit:'rem' appends rem", () => {
    const desc: KnobBodyDescriptor = {
      key: "lineHeight",
      kind: "range",
      unit: "rem",
    };
    expect(encodeKnobValue(desc, 1.5)).toBe("1.5rem");
  });

  test("range with no unit emits bare numeric (no append)", () => {
    const desc: KnobBodyDescriptor = { key: "fontWeight", kind: "range" };
    expect(encodeKnobValue(desc, 400)).toBe("400");
  });
});

describe("encodeKnobValue — non-range kinds", () => {
  test("color emits raw hex (no formatting)", () => {
    const desc: KnobBodyDescriptor = { key: "primaryColor", kind: "color" };
    expect(encodeKnobValue(desc, "#ff0066")).toBe("#ff0066");
  });

  test("select emits raw option string", () => {
    const desc: KnobBodyDescriptor = { key: "density", kind: "select" };
    expect(encodeKnobValue(desc, "compact")).toBe("compact");
    expect(encodeKnobValue(desc, "spacious")).toBe("spacious");
  });

  test("text emits raw value", () => {
    const desc: KnobBodyDescriptor = { key: "headline", kind: "text" };
    expect(encodeKnobValue(desc, "Hello world")).toBe("Hello world");
  });
});

describe("encodeKnobValue — empty / missing values", () => {
  test("undefined returns null (skip)", () => {
    const desc: KnobBodyDescriptor = { key: "primaryColor", kind: "color" };
    expect(encodeKnobValue(desc, undefined)).toBeNull();
  });

  test("null returns null (skip)", () => {
    const desc: KnobBodyDescriptor = { key: "primaryColor", kind: "color" };
    expect(encodeKnobValue(desc, null)).toBeNull();
  });

  test("empty string returns null (skip — preserves draft default)", () => {
    const desc: KnobBodyDescriptor = { key: "density", kind: "select" };
    expect(encodeKnobValue(desc, "")).toBeNull();
  });

  test("whitespace-only returns null", () => {
    const desc: KnobBodyDescriptor = { key: "headline", kind: "text" };
    expect(encodeKnobValue(desc, "   ")).toBeNull();
  });

  test("empty range value returns null (no override)", () => {
    const desc: KnobBodyDescriptor = {
      key: "borderRadius",
      kind: "range",
      unit: "px",
    };
    expect(encodeKnobValue(desc, "")).toBeNull();
  });
});

// ── buildKnobBody (composite) ─────────────────────────────────────

describe("buildKnobBody — composite", () => {
  test("LEGACY_DESCRIPTORS shape: slider at +30 emits signed delta, density emits raw", () => {
    const descriptors: KnobBodyDescriptor[] = [
      { key: "primaryColor", kind: "color" },
      { key: "secondaryColor", kind: "color" },
      {
        key: "spacingScale",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
      },
      { key: "borderRadius", kind: "range", unit: "px" },
      { key: "density", kind: "select" },
    ];
    const body = buildKnobBody(descriptors, {
      primaryColor: "#ff0066",
      spacingScale: 30,
      borderRadius: 8,
      // density not set — should be omitted from body.
    });
    expect(body).toEqual({
      primaryColor: "#ff0066",
      spacingScale: "+30%",
      borderRadius: "8px",
    });
  });

  test("only meaningful values land — empties are dropped", () => {
    const descriptors: KnobBodyDescriptor[] = [
      { key: "primaryColor", kind: "color" },
      { key: "density", kind: "select" },
      {
        key: "spacingScale",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
      },
    ];
    const body = buildKnobBody(descriptors, {
      primaryColor: "",
      density: "",
      spacingScale: "",
    });
    expect(body).toEqual({});
  });

  test("borderRadius=0 is preserved (meaningful zero), color empty is dropped", () => {
    const descriptors: KnobBodyDescriptor[] = [
      { key: "primaryColor", kind: "color" },
      { key: "borderRadius", kind: "range", unit: "px" },
    ];
    const body = buildKnobBody(descriptors, {
      primaryColor: "",
      borderRadius: 0,
    });
    expect(body).toEqual({ borderRadius: "0px" });
  });

  test("spacingScale=0 emits '+0%' (meaningful zero)", () => {
    const descriptors: KnobBodyDescriptor[] = [
      {
        key: "spacingScale",
        kind: "range",
        behavior: "scale-spacing",
        unit: "%",
      },
    ];
    const body = buildKnobBody(descriptors, { spacingScale: 0 });
    expect(body).toEqual({ spacingScale: "+0%" });
  });

  test("descriptors not present in values produce no body keys", () => {
    const descriptors: KnobBodyDescriptor[] = [
      { key: "primaryColor", kind: "color" },
      { key: "density", kind: "select" },
    ];
    const body = buildKnobBody(descriptors, {});
    expect(body).toEqual({});
  });
});
