import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

mock.module("../../web/src/routes/api/docs/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────
import { GET } from "../../web/src/routes/api/docs/+server";

afterAll(() => {
  restoreModuleMocks();
});

// ── GET /api/docs ────────────────────────────────────────────────

describe("GET /api/docs", () => {
  test("returns routes array with method, path, description, category", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/docs",
    });

    const res = await GET(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.routes).toBeArray();
    expect(data.routes.length).toBeGreaterThan(0);

    const first = data.routes[0];
    expect(first.method).toBeDefined();
    expect(first.path).toBeDefined();
    expect(first.description).toBeDefined();
    expect(first.category).toBeDefined();
  });

  test("every route has required fields", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/docs",
    });

    const res = await GET(event);
    const data = await jsonFromResponse(res);

    for (const route of data.routes) {
      expect(typeof route.method).toBe("string");
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(route.method);
      expect(typeof route.path).toBe("string");
      expect(route.path.startsWith("/api/")).toBe(true);
      expect(typeof route.description).toBe("string");
      expect(route.description.length).toBeGreaterThan(0);
      expect(typeof route.category).toBe("string");
    }
  });
});
