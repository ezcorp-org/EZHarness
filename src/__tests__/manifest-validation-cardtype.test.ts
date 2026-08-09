/**
 * Tests for `cardType` manifest validation.
 *
 * `cardType` was free-form `string` and validated nowhere, so a typo
 * (`"weather-pannel"`) installed cleanly and then silently rendered as
 * the generic collapsed DefaultCard — the author lost their custom UI
 * with no error, anywhere, to explain why.
 *
 * Note the deliberate asymmetry with `cardLayout` (see
 * manifest-validation-cardlayout.test.ts): an unknown `cardLayout` only
 * changes WHERE a card renders and is tolerated for forward-compat,
 * while an unknown `cardType` silently discards the entire authored
 * rendering. That is a bug in the manifest, not a version skew.
 */
import { test, expect, describe } from "bun:test";
import { validateManifestV2 } from "../extensions/manifest";
import { KNOWN_CARD_TYPES } from "../extensions/card-types";

const base = {
  schemaVersion: 2,
  name: "test-ext",
  version: "1.0.0",
  description: "Test",
  author: { name: "Tester" },
  entrypoint: "index.ts",
};

function withTool(tool: Record<string, unknown>) {
  return {
    ...base,
    tools: [
      {
        name: "t",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        ...tool,
      },
    ],
  };
}

describe("validateManifestV2 — cardType", () => {
  test("every known cardType validates", () => {
    for (const cardType of KNOWN_CARD_TYPES) {
      const result = validateManifestV2(withTool({ cardType }));
      expect({ cardType, valid: result.valid, errors: result.errors }).toEqual({
        cardType,
        valid: true,
        errors: [],
      });
    }
  });

  test("omitted cardType is fine (most tools do not declare one)", () => {
    const result = validateManifestV2(withTool({}));
    expect(result.valid).toBe(true);
  });

  test("a typo is REJECTED, and the error names the tool and the known set", () => {
    const result = validateManifestV2(withTool({ cardType: "weather-pannel" }));
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.includes("cardType"));
    expect(err).toBeDefined();
    expect(err).toContain("tools[0].cardType");
    expect(err).toContain("weather-pannel");
    // The message has to be actionable — it lists what IS renderable.
    expect(err).toContain("weather-panel");
  });

  test("a non-string cardType is rejected", () => {
    const result = validateManifestV2(withTool({ cardType: 42 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cardType must be a string"))).toBe(true);
  });

  test("the offending tool INDEX is reported for a multi-tool manifest", () => {
    const manifest = {
      ...base,
      tools: [
        {
          name: "ok",
          description: "d",
          inputSchema: { type: "object" },
          cardType: "terminal",
        },
        {
          name: "typo",
          description: "d",
          inputSchema: { type: "object" },
          cardType: "termnal",
        },
      ],
    };
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools[1].cardType"))).toBe(true);
    expect(result.errors.some((e) => e.includes("tools[0].cardType"))).toBe(false);
  });
});
