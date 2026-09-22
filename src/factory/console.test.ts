import { describe, expect, test } from "bun:test";

process.env.EZCORP_JWT_SECRET = "console-key-test-secret-with-enough-length";
const { UNBOUND_SOURCE_UNAVAILABLE, factoryConsoleKey } = await import("./console");

describe("factory console composition", () => {
  test("the signing key is 32 bytes, stable for a tenant, and different for another tenant", async () => {
    const first = await factoryConsoleKey("tenant-a");
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.byteLength).toBe(32);
    expect(Buffer.from(await factoryConsoleKey("tenant-a")).equals(Buffer.from(first))).toBe(true);
    expect(Buffer.from(await factoryConsoleKey("tenant-b")).equals(Buffer.from(first))).toBe(false);
  });

  test("an encrypted installation's console has no unbound package source, and says so by name", async () => {
    await expect(UNBOUND_SOURCE_UNAVAILABLE.get("sha256:any" as never)).rejects.toThrow("factory_console_package_source_unavailable");
    await expect(UNBOUND_SOURCE_UNAVAILABLE.put(new Uint8Array() as never)).rejects.toThrow("factory_console_package_source_unavailable");
  });
});
