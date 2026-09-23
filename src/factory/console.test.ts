import { describe, expect, test } from "bun:test";

process.env.EZCORP_JWT_SECRET = "console-key-test-secret-with-enough-length";
const { UNBOUND_SOURCE_UNAVAILABLE, factoryConsoleCursorTtlMs, factoryConsoleKey } = await import("./console");

describe("factory console composition", () => {
  test("the signing key is 32 bytes, stable for a tenant, and different for another tenant", async () => {
    const first = await factoryConsoleKey("tenant-a");
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.byteLength).toBe(32);
    expect(Buffer.from(await factoryConsoleKey("tenant-a")).equals(Buffer.from(first))).toBe(true);
    expect(Buffer.from(await factoryConsoleKey("tenant-b")).equals(Buffer.from(first))).toBe(false);
  });

  test("the cursor lifetime is the installation setting, bounded, and a bad value is refused by name", () => {
    expect(factoryConsoleCursorTtlMs({})).toBe(15 * 60_000);
    expect(factoryConsoleCursorTtlMs({ EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS: "" })).toBe(15 * 60_000);
    expect(factoryConsoleCursorTtlMs({ EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS: "30000" })).toBe(30_000);
    expect(factoryConsoleCursorTtlMs({ EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS: "5000" })).toBe(5_000);
    expect(factoryConsoleCursorTtlMs({ EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS: "3600000" })).toBe(3_600_000);
    for (const raw of ["4999", "3600001", "30s", "-1", "1e4"]) {
      expect(() => factoryConsoleCursorTtlMs({ EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS: raw })).toThrow("EZCORP_FACTORY_CONSOLE_CURSOR_TTL_MS must be an integer from 5000 to 3600000 milliseconds.");
    }
  });

  test("an encrypted installation's console has no unbound package source, and says so by name", async () => {
    await expect(UNBOUND_SOURCE_UNAVAILABLE.get("sha256:any" as never)).rejects.toThrow("factory_console_package_source_unavailable");
    await expect(UNBOUND_SOURCE_UNAVAILABLE.put(new Uint8Array() as never)).rejects.toThrow("factory_console_package_source_unavailable");
  });
});
