import { test, expect, describe } from "bun:test";
import { apiRegistry, } from "../api-registry";

describe("API Registry", () => {
  test("has entries", () => {
    expect(apiRegistry.length).toBeGreaterThan(0);
  });

  test("all entries have required fields", () => {
    for (const entry of apiRegistry) {
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(entry.method);
      expect(entry.path).toMatch(/^\/api\//);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
    }
  });

  test("some entries have schema keys for Zod conversion", () => {
    const withSchemas = apiRegistry.filter((e) => e.schemaKey);
    expect(withSchemas.length).toBeGreaterThan(0);
    for (const entry of withSchemas) {
      expect(typeof entry.schemaKey).toBe("string");
      expect(entry.schemaKey!.length).toBeGreaterThan(0);
    }
  });

  test("covers major route categories", () => {
    const categories = new Set(apiRegistry.map((e) => e.category));
    const expected = ["auth", "conversations", "agents", "extensions", "marketplace", "settings"];
    for (const cat of expected) {
      expect(categories.has(cat)).toBe(true);
    }
  });

  test("no duplicate method+path combinations", () => {
    const keys = apiRegistry.map((e) => `${e.method} ${e.path}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
