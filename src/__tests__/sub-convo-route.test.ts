import { test, expect, describe } from "bun:test";

describe("GET /api/conversations/[id]/sub-conversations route", () => {
  test("route module exports GET handler", async () => {
    const mod = await import("../../web/src/routes/api/conversations/[id]/sub-conversations/+server");
    expect(mod.GET).toBeDefined();
    expect(typeof mod.GET).toBe("function");
  });

  test("route module does not export POST, PUT, DELETE handlers", async () => {
    const mod = await import("../../web/src/routes/api/conversations/[id]/sub-conversations/+server") as Record<string, unknown>;
    expect(mod.POST).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
    expect(mod.DELETE).toBeUndefined();
  });

  test("GET handler is a RequestHandler function", async () => {
    const mod = await import("../../web/src/routes/api/conversations/[id]/sub-conversations/+server");
    // RequestHandlers accept a single event argument and return a Response
    expect(mod.GET.length).toBeGreaterThanOrEqual(1);
  });
});
