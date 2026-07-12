/**
 * Manifest-surface tests for the deterministic-preprocess feature
 * (tasks/deterministic-preprocess.md, locked decision 1):
 *
 *   - `preprocessors` is an OPTIONAL top-level array of
 *     `{ tool, accepts, description? }`.
 *   - `tool` MUST name a tool declared in the same manifest's `tools[]`.
 *   - `accepts` is a NON-EMPTY array of exact MIME strings or `type/*`
 *     globs.
 *   - Validation applies to BOTH schemaVersion 2 and 3 (one validator
 *     gates both), and `migrateManifestV2ToV3` passes the field through
 *     untouched so the runtime always sees it.
 *
 * Pure validator tests — no DB, no subprocess.
 */
import { describe, expect, test } from "bun:test";
import {
  migrateManifestV2ToV3,
  validateManifestV2,
  validateNpmDependenciesBlock,
  validatePreprocessorsArray,
} from "../extensions/manifest";
import type { ExtensionManifest } from "../extensions/types";

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    name: "preproc-test",
    version: "1.0.0",
    description: "test manifest",
    author: { name: "tester" },
    entrypoint: "./index.ts",
    tools: [
      {
        name: "identify_thing",
        description: "identify a thing",
        inputSchema: { type: "object" },
      },
    ],
    permissions: {},
    ...overrides,
  };
}

describe("validateManifestV2 — preprocessors surface", () => {
  test("manifest WITHOUT preprocessors stays valid (field is optional)", () => {
    const res = validateManifestV2(baseManifest());
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("valid preprocessors declaration passes (exact MIME + glob + description)", () => {
    const res = validateManifestV2(
      baseManifest({
        preprocessors: [
          {
            tool: "identify_thing",
            accepts: ["image/png", "image/*"],
            description: "runs on every image",
          },
        ],
      }),
    );
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("tool not declared in tools[] is a manifest error", () => {
    const res = validateManifestV2(
      baseManifest({
        preprocessors: [{ tool: "not_a_tool", accepts: ["image/png"] }],
      }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('preprocessors[0].tool "not_a_tool"'))).toBe(true);
    expect(res.errors.some((e) => e.includes("identify_thing"))).toBe(true);
  });

  test("missing / empty tool is a manifest error", () => {
    const res = validateManifestV2(
      baseManifest({ preprocessors: [{ accepts: ["image/png"] }] }),
    );
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("preprocessors[0].tool is required")),
    ).toBe(true);
  });

  test("empty accepts array is a manifest error", () => {
    const res = validateManifestV2(
      baseManifest({ preprocessors: [{ tool: "identify_thing", accepts: [] }] }),
    );
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("preprocessors[0].accepts must be a non-empty array")),
    ).toBe(true);
  });

  test("missing accepts is a manifest error", () => {
    const res = validateManifestV2(
      baseManifest({ preprocessors: [{ tool: "identify_thing" }] }),
    );
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("preprocessors[0].accepts must be a non-empty array")),
    ).toBe(true);
  });

  test("malformed accepts entries are rejected (non-string, bare type, */*, whitespace)", () => {
    const res = validateManifestV2(
      baseManifest({
        preprocessors: [
          { tool: "identify_thing", accepts: [42, "image", "*/*", "image / png"] },
        ],
      }),
    );
    expect(res.valid).toBe(false);
    for (const j of [0, 1, 2, 3]) {
      expect(
        res.errors.some((e) => e.includes(`preprocessors[0].accepts[${j}]`)),
      ).toBe(true);
    }
  });

  test("non-array preprocessors is a manifest error", () => {
    const res = validateManifestV2(baseManifest({ preprocessors: { tool: "x" } }));
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("preprocessors must be an array");
  });

  test("non-object entries are rejected (null, array, string)", () => {
    const res = validateManifestV2(
      baseManifest({ preprocessors: [null, ["x"], "nope"] }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("preprocessors[0] must be an object"))).toBe(true);
    expect(res.errors.some((e) => e.includes("preprocessors[1] must be an object"))).toBe(true);
    expect(res.errors.some((e) => e.includes("preprocessors[2] must be an object"))).toBe(true);
  });

  test("non-string description is a manifest error", () => {
    const res = validateManifestV2(
      baseManifest({
        preprocessors: [
          { tool: "identify_thing", accepts: ["image/png"], description: 7 },
        ],
      }),
    );
    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) => e.includes("preprocessors[0].description must be a string")),
    ).toBe(true);
  });

  test("a manifest with NO tools[] reports '<none>' in the cross-check error", () => {
    const res = validateManifestV2(
      baseManifest({
        tools: undefined,
        entrypoint: undefined,
        preprocessors: [{ tool: "ghost", accepts: ["image/png"] }],
      }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("<none>"))).toBe(true);
  });

  test("schemaVersion 3 manifests are validated by the same rules", () => {
    const bad = validateManifestV2(
      baseManifest({
        schemaVersion: 3,
        preprocessors: [{ tool: "ghost", accepts: ["image/png"] }],
      }),
    );
    expect(bad.valid).toBe(false);

    const good = validateManifestV2(
      baseManifest({
        schemaVersion: 3,
        preprocessors: [{ tool: "identify_thing", accepts: ["image/jpeg"] }],
      }),
    );
    expect(good.valid).toBe(true);
  });
});

describe("validatePreprocessorsArray — direct edge cases", () => {
  test("accumulates errors across multiple entries", () => {
    const errors: string[] = [];
    validatePreprocessorsArray(
      [
        { tool: "known", accepts: ["image/png"] },
        { tool: "", accepts: ["image/png"] },
        { tool: "known", accepts: "image/png" },
      ],
      ["known"],
      errors,
    );
    expect(errors.some((e) => e.includes("preprocessors[1].tool is required"))).toBe(true);
    expect(errors.some((e) => e.includes("preprocessors[2].accepts must be a non-empty array"))).toBe(true);
    // Entry 0 is clean — exactly the two errors above.
    expect(errors).toHaveLength(2);
  });
});

describe("validateManifestV2 — npmDependencies surface", () => {
  test("manifest WITHOUT npmDependencies stays valid (field is optional)", () => {
    const res = validateManifestV2(baseManifest());
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("valid npmDependencies map passes (scoped + plain names, range values)", () => {
    const res = validateManifestV2(
      baseManifest({
        npmDependencies: { "@zxing/library": "^0.23.0", "fast-png": "^8.0.0", "jpeg-js": "0.4.4" },
      }),
    );
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("non-object npmDependencies is a manifest error", () => {
    const res = validateManifestV2(baseManifest({ npmDependencies: "exceljs@^4.4.0" }));
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("npmDependencies must be a plain object");
  });

  test("array npmDependencies is a manifest error", () => {
    const res = validateManifestV2(baseManifest({ npmDependencies: ["exceljs"] }));
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("npmDependencies must be a plain object");
  });

  test("bad package-name keys are rejected (uppercase, spaces, path traversal)", () => {
    const res = validateManifestV2(
      baseManifest({
        npmDependencies: {
          "Not-Lower": "^1.0.0",
          "has space": "^1.0.0",
          "../evil": "^1.0.0",
        },
      }),
    );
    expect(res.valid).toBe(false);
    for (const key of ["Not-Lower", "has space", "../evil"]) {
      expect(res.errors.some((e) => e.includes(`npmDependencies key "${key}"`))).toBe(true);
    }
  });

  test("an over-214-char package name is rejected", () => {
    const longName = "a".repeat(215);
    const res = validateManifestV2(baseManifest({ npmDependencies: { [longName]: "^1.0.0" } }));
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes(`npmDependencies key "${longName}"`))).toBe(true);
  });

  test("empty-string and non-string range values are rejected", () => {
    const res = validateManifestV2(
      baseManifest({ npmDependencies: { "pkg-a": "", "pkg-b": 42 } }),
    );
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("npmDependencies.pkg-a"))).toBe(true);
    expect(res.errors.some((e) => e.includes("npmDependencies.pkg-b"))).toBe(true);
  });
});

describe("validateNpmDependenciesBlock — direct edge cases", () => {
  test("null value is rejected as a non-object", () => {
    const errors: string[] = [];
    validateNpmDependenciesBlock(null, errors);
    expect(errors).toEqual(["npmDependencies must be a plain object"]);
  });

  test("valid map accumulates no errors", () => {
    const errors: string[] = [];
    validateNpmDependenciesBlock({ "@scope/pkg": "^1.2.3", plain: "2.0.0" }, errors);
    expect(errors).toEqual([]);
  });
});

describe("migrateManifestV2ToV3 — npmDependencies passthrough", () => {
  test("v2 → v3 migration preserves npmDependencies verbatim", () => {
    const manifest = baseManifest({
      npmDependencies: { "@zxing/library": "^0.23.0", "fast-png": "^8.0.0" },
    }) as unknown as ExtensionManifest;
    const migrated = migrateManifestV2ToV3(manifest);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.npmDependencies).toEqual({
      "@zxing/library": "^0.23.0",
      "fast-png": "^8.0.0",
    });
  });
});

describe("migrateManifestV2ToV3 — preprocessors passthrough", () => {
  test("v2 → v3 migration preserves the preprocessors field verbatim", () => {
    const manifest = baseManifest({
      preprocessors: [{ tool: "identify_thing", accepts: ["image/png", "image/jpeg"] }],
    }) as unknown as ExtensionManifest;
    const migrated = migrateManifestV2ToV3(manifest);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.preprocessors).toEqual([
      { tool: "identify_thing", accepts: ["image/png", "image/jpeg"] },
    ]);
  });

  test("authored v3 manifests pass through with preprocessors intact", () => {
    const manifest = baseManifest({
      schemaVersion: 3,
      preprocessors: [{ tool: "identify_thing", accepts: ["image/*"] }],
    }) as unknown as ExtensionManifest;
    const migrated = migrateManifestV2ToV3(manifest);
    expect(migrated.preprocessors).toEqual([
      { tool: "identify_thing", accepts: ["image/*"] },
    ]);
  });
});
