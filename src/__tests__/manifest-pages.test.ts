/**
 * Manifest `pages` array validation (Extension Pages Hub).
 * Mirrors manifest-message-toolbar.test.ts's structure.
 */
import { test, expect, describe } from "bun:test";
import { validateManifestV2, validatePagesArray } from "../extensions/manifest";

function baseManifest(pages: unknown): Record<string, unknown> {
  return {
    schemaVersion: 2,
    name: "cron-dashboard",
    version: "1.0.0",
    description: "test",
    author: { name: "t" },
    permissions: {},
    pages,
  };
}

describe("validatePagesArray", () => {
  test("accepts a valid declaration with all fields", () => {
    const errors: string[] = [];
    validatePagesArray(
      [{ id: "dashboard", title: "Cron Dashboard", icon: "Clock", description: "Scheduled runs" }],
      errors,
    );
    expect(errors).toEqual([]);
  });

  test("accepts minimal id+title entries, up to 3", () => {
    const errors: string[] = [];
    validatePagesArray(
      [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
      ],
      errors,
    );
    expect(errors).toEqual([]);
  });

  test("rejects non-array", () => {
    const errors: string[] = [];
    validatePagesArray({ id: "x" }, errors);
    expect(errors).toEqual(["pages must be an array"]);
  });

  test("rejects more than 3 pages", () => {
    const errors: string[] = [];
    validatePagesArray(
      [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
        { id: "d", title: "D" },
      ],
      errors,
    );
    expect(errors.some((e) => e.includes("at most 3"))).toBe(true);
  });

  test("rejects bad ids (regex), duplicates, and non-object entries", () => {
    const errors: string[] = [];
    validatePagesArray(
      [
        { id: "UPPER", title: "X" },
        { id: "ok", title: "X" },
        { id: "ok", title: "Dup" },
        "not-an-object",
        { title: "missing id" },
        { id: "x".repeat(40), title: "too long id" },
      ],
      errors,
    );
    expect(errors.filter((e) => e.includes(".id must match"))).toHaveLength(3);
    expect(errors.some((e) => e.includes("is duplicated"))).toBe(true);
    expect(errors.some((e) => e.includes("pages[3] must be an object"))).toBe(true);
  });

  test("rejects missing/over-long titles and bad icon/description types", () => {
    const errors: string[] = [];
    validatePagesArray(
      [
        { id: "a" },
        { id: "b", title: "t".repeat(51) },
        { id: "c", title: "ok", icon: 42 },
        { id: "d", title: "ok", description: 42 },
        { id: "e", title: "ok", description: "d".repeat(201) },
      ],
      errors,
    );
    expect(errors.some((e) => e.includes("pages[0].title is required"))).toBe(true);
    expect(errors.some((e) => e.includes("pages[1].title must be at most 50"))).toBe(true);
    expect(errors.some((e) => e.includes("pages[2].icon must be a string"))).toBe(true);
    expect(errors.some((e) => e.includes("pages[3].description must be a string"))).toBe(true);
    expect(errors.some((e) => e.includes("pages[4].description must be at most 200"))).toBe(true);
  });
});

describe("validateManifestV2 integration", () => {
  test("manifest with valid pages passes", () => {
    const result = validateManifestV2(baseManifest([{ id: "dashboard", title: "Dash" }]));
    expect(result.valid).toBe(true);
  });

  test("manifest with invalid pages fails with the pages error", () => {
    const result = validateManifestV2(baseManifest([{ id: "Bad Id", title: "Dash" }]));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("pages[0].id"))).toBe(true);
  });

  test("manifest without pages is unaffected", () => {
    const m = baseManifest(undefined);
    delete m.pages;
    expect(validateManifestV2(m).valid).toBe(true);
  });
});
