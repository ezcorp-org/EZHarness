// Tests for lib/tokens.ts — design-system extraction.
//
// Focuses on the priority order (tokens.json > tailwind > css-vars >
// theme.ts > greenfield) and the parsers' robustness on real-world
// fixture content.

import { describe, expect, test } from "bun:test";
import {
  extractFromRoot,
  parseTokensJson,
  parseTailwindSource,
  parseCssVariables,
  unwrapTokenValue,
  unwrapNeutralRamp,
  type ExtractDeps,
} from "./tokens";

// ── Fake fs helper ─────────────────────────────────────────────────

function makeDeps(files: Record<string, string>): ExtractDeps {
  return {
    readFile: async (path) => files[path] ?? null,
    glob: async (pattern) => {
      // Convert glob to a regex: `**` → any path, `*` → no slashes, escape
      // dots, prefix-anchor + suffix-anchor. Handles every pattern this
      // module emits today.
      const re = new RegExp(
        "^" +
          pattern
            .replace(/\./g, "\\.")
            .replace(/\*\*/g, "::DOUBLESTAR::")
            .replace(/\*/g, "[^/]*")
            .replace(/::DOUBLESTAR::/g, ".*") +
          "$",
      );
      return Object.keys(files).filter((p) => re.test(p));
    },
  };
}

// ── Token-value unwrappers ────────────────────────────────────────

describe("unwrapTokenValue", () => {
  test("string passes through", () => {
    expect(unwrapTokenValue("#ff0066")).toBe("#ff0066");
  });
  test("style-dictionary {value: '#hex'} unwraps", () => {
    expect(unwrapTokenValue({ value: "#ff0066" })).toBe("#ff0066");
  });
  test("non-string non-object returns undefined", () => {
    expect(unwrapTokenValue(42)).toBeUndefined();
    expect(unwrapTokenValue(null)).toBeUndefined();
  });
});

describe("unwrapNeutralRamp", () => {
  test("array of strings", () => {
    expect(unwrapNeutralRamp(["#000", "#fff"])).toEqual(["#000", "#fff"]);
  });
  test("style-dictionary scale object sorted by key", () => {
    expect(
      unwrapNeutralRamp({
        100: { value: "#aaa" },
        50: { value: "#fff" },
        500: { value: "#555" },
      }),
    ).toEqual(["#fff", "#aaa", "#555"]);
  });
  test("non-array non-object returns undefined", () => {
    expect(unwrapNeutralRamp("string")).toBeUndefined();
  });
});

// ── parseTokensJson ────────────────────────────────────────────────

describe("parseTokensJson", () => {
  test("style-dictionary shape", () => {
    const tokens = {
      color: {
        primary: { value: "#ff0066" },
        secondary: { value: "#0066ff" },
        neutral: { 50: { value: "#fafafa" }, 900: { value: "#0a0a0a" } },
      },
    };
    expect(parseTokensJson(tokens)).toEqual({
      colors: {
        primary: "#ff0066",
        secondary: "#0066ff",
        neutral: ["#fafafa", "#0a0a0a"],
      },
    });
  });

  test("flat shape (no `value` wrapper)", () => {
    expect(parseTokensJson({ colors: { primary: "#ff0066" } })).toEqual({
      colors: { primary: "#ff0066" },
    });
  });

  test("garbage input returns empty partial", () => {
    expect(parseTokensJson(null)).toEqual({});
    expect(parseTokensJson(42)).toEqual({});
    expect(parseTokensJson({})).toEqual({});
  });
});

// ── parseTailwindSource ────────────────────────────────────────────

describe("parseTailwindSource", () => {
  test("extracts primary/secondary from theme.colors", () => {
    const src = `
      module.exports = {
        theme: {
          extend: {
            colors: {
              primary: '#ff0066',
              secondary: '#0066ff',
              neutral: { 100: '#fafafa' }
            }
          }
        }
      };
    `;
    const result = parseTailwindSource(src);
    expect(result?.colors?.primary).toBe("#ff0066");
    expect(result?.colors?.secondary).toBe("#0066ff");
  });

  test("extracts display + body fontFamily", () => {
    const src = `
      const config = {
        theme: {
          fontFamily: {
            display: 'Söhne Breit',
            sans: 'Söhne'
          }
        }
      };
    `;
    const result = parseTailwindSource(src);
    expect(result?.typography?.display).toBe("Söhne Breit");
    expect(result?.typography?.body).toBe("Söhne");
  });

  test("returns null when nothing matches", () => {
    expect(parseTailwindSource("// just comments")).toBeNull();
  });
});

// ── parseCssVariables ──────────────────────────────────────────────

describe("parseCssVariables", () => {
  test("extracts --color-* and --space-unit from :root", () => {
    const src = `
      :root {
        --color-primary: #ff0066;
        --color-secondary: #0066ff;
        --space-unit: 8px;
        --font-family-display: "Söhne";
      }
    `;
    const result = parseCssVariables(src);
    expect(result?.colors?.primary).toBe("#ff0066");
    expect(result?.colors?.secondary).toBe("#0066ff");
    expect(result?.spacing?.unit).toBe(8);
  });

  test("space-unit without unit suffix parses as px", () => {
    const result = parseCssVariables(":root { --space-unit: 12; }");
    expect(result?.spacing?.unit).toBe(12);
  });

  test("returns null when :root missing", () => {
    expect(parseCssVariables("body { color: red; }")).toBeNull();
  });

  test("returns null when no recognized vars in :root", () => {
    expect(parseCssVariables(":root { --random: 1; }")).toBeNull();
  });
});

// ── Priority order ─────────────────────────────────────────────────

describe("extractFromRoot — priority order", () => {
  test("tokens.json wins over tailwind.config", async () => {
    const deps = makeDeps({
      "tokens.json": JSON.stringify({ color: { primary: { value: "#aaa" } } }),
      "tailwind.config.ts": `colors: { primary: '#bbb' }`,
    });
    const ds = await extractFromRoot(deps);
    expect(ds.source).toBe("tokens.json");
    expect(ds.colors.primary).toBe("#aaa");
  });

  test("tailwind.config wins over CSS vars", async () => {
    const deps = makeDeps({
      "tailwind.config.ts": `colors: { primary: '#aaa' }`,
      "src/app.css": `:root { --color-primary: #bbb; }`,
    });
    const ds = await extractFromRoot(deps);
    expect(ds.source).toBe("tailwind");
    expect(ds.colors.primary).toBe("#aaa");
  });

  test("CSS vars win over theme.ts", async () => {
    const deps = makeDeps({
      "src/app.css": `:root { --color-primary: #aaa; }`,
      "theme.ts": `colors: { primary: '#bbb' }`,
    });
    const ds = await extractFromRoot(deps);
    expect(ds.source).toBe("css-vars");
    expect(ds.colors.primary).toBe("#aaa");
  });

  test("greenfield fallback when nothing matches", async () => {
    const deps = makeDeps({});
    const ds = await extractFromRoot(deps);
    expect(ds.source).toBe("greenfield");
    expect(ds.colors.primary).toBe("#0066ff"); // fallback default
  });

  test("partial source merges with fallback (missing typography filled in)", async () => {
    const deps = makeDeps({
      "tokens.json": JSON.stringify({ color: { primary: { value: "#aaa" } } }),
    });
    const ds = await extractFromRoot(deps);
    expect(ds.colors.primary).toBe("#aaa");
    // Typography still populated from fallback
    expect(ds.typography.display).toBeTruthy();
    expect(ds.typography.scale.length).toBeGreaterThan(0);
  });
});

// ── Component catalog ──────────────────────────────────────────────

describe("extractFromRoot — component catalog", () => {
  test("collects components from common dirs", async () => {
    const deps = makeDeps({
      "src/components/Button.svelte": "<button />",
      "web/src/components/Card.tsx": "export const Card = () => null;",
      "node_modules/lib/components/Ignored.svelte": "ignore me",
      "tailwind.config.ts": `colors: { primary: '#aaa' }`,
    });
    const ds = await extractFromRoot(deps);
    const names = ds.components.map((c) => c.name);
    expect(names).toContain("Button");
    expect(names).toContain("Card");
    expect(names).not.toContain("Ignored");
  });
});
