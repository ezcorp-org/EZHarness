import { describe, test, expect } from "bun:test";

import type { ExtensionManifestV2 } from "../extensions/types";
import { validateManifestV2 } from "../extensions/manifest";

// ── Test Helper ──────────────────────────────────────────────────
// Mirrors `src/__tests__/manifest-v2.test.ts`'s `makeValidManifest` so
// every test below starts from a known-valid baseline and only varies
// the `acceptedAttachmentMimes` field.

function makeValidManifest(
  overrides: Partial<ExtensionManifestV2> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-package",
    version: "1.0.0",
    description: "A test package",
    author: { name: "Test Author" },
    entrypoint: "./index.ts",
    tools: [
      {
        name: "doSomething",
        description: "Does something",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    permissions: {},
    ...overrides,
  };
}

// All assertions about the `acceptedAttachmentMimes[i]` errors look for
// this stable substring (the validator emits a single message format).
const FIELD_ERROR = "acceptedAttachmentMimes";

describe("validateManifestV2 — acceptedAttachmentMimes", () => {
  // ── Valid inputs ───────────────────────────────────────────────

  test("well-formed type/subtype strings pass", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["application/pdf", "image/png"],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("omitted (undefined) passes — field is optional", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: undefined,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.includes(FIELD_ERROR))).toBe(false);
  });

  test("empty array [] passes (current contract: validator iterates zero items)", () => {
    // Current validator: only iterates entries when present, so [] is accepted.
    // Documenting actual behavior — see `src/extensions/manifest.ts:203-216`.
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: [],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.includes(FIELD_ERROR))).toBe(false);
  });

  test("real-world Office MIME passes", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(true);
  });

  // ── Invalid: not an array ─────────────────────────────────────

  test("string value (not array) is rejected", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: "application/pdf" as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("acceptedAttachmentMimes must be an array of strings"),
      ),
    ).toBe(true);
  });

  test("object value (not array) is rejected", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: { "0": "application/pdf" } as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("acceptedAttachmentMimes must be an array of strings"),
      ),
    ).toBe(true);
  });

  test("number value (not array) is rejected", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: 42 as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("acceptedAttachmentMimes must be an array of strings"),
      ),
    ).toBe(true);
  });

  // ── Invalid: non-string array entries ─────────────────────────

  test("array containing a number entry [123] is rejected", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: [123] as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test("array containing a null entry [null] is rejected", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: [null] as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test("array containing an object entry [{}] is rejected", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: [{}] as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test("multiple bad entries each report their index", () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["application/pdf", 123, "image/png", null] as any,
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    // Indices 1 and 3 are the malformed entries.
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[1]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[3]"))).toBe(true);
    // Indices 0 and 2 are valid; no error should reference them.
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[2]"))).toBe(false);
  });

  // ── Invalid: malformed MIME strings ───────────────────────────

  test('empty MIME string [""] is rejected', () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: [""],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test('missing slash ["pdf"] is rejected', () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["pdf"],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  // ── Strict type/subtype enforcement (RFC 6838) ────────────────
  //
  // The validator must reject malformed MIMEs that have the rough shape
  // "x/y" but aren't valid type/subtype pairs (extra slashes, empty halves).

  test('too many slashes ["a/b/c"] is rejected', () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["a/b/c"],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test('trailing slash ["application/"] is rejected', () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["application/"],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test('leading slash ["/pdf"] is rejected', () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["/pdf"],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });

  test('bare slash ["/"] is rejected', () => {
    const manifest = makeValidManifest({
      acceptedAttachmentMimes: ["/"],
    });
    const result = validateManifestV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptedAttachmentMimes[0]"))).toBe(true);
  });
});
