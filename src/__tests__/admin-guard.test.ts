import { test, expect, describe } from "bun:test";

describe("admin moderation page guard", () => {
  test("+page.server.ts exists and contains redirect + role check", async () => {
    const file = Bun.file("web/src/routes/(app)/admin/moderation/+page.server.ts");
    expect(await file.exists()).toBe(true);

    const content = await file.text();
    expect(content).toContain("redirect");
    expect(content).toContain('role !== "admin"');
    expect(content).toContain("302");
  });
});
