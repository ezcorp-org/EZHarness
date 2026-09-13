import { describe, expect, test } from "bun:test";
import { decodeFactoryPageBase64, encodeFactoryPageBase64, FACTORY_PAGE_BYTES_LIMIT } from "./page-bytes";

describe("factory page activity encoding", () => {
  test("round-trips adversarial bytes at the exact page limit", () => {
    const source = new TextEncoder().encode(`${"\\\"".repeat((FACTORY_PAGE_BYTES_LIMIT - 4) / 2)}🙂`);
    expect(source.byteLength).toBe(FACTORY_PAGE_BYTES_LIMIT);
    const encoded = encodeFactoryPageBase64(source);
    expect(encoded.length).toBe(43_692);
    expect(decodeFactoryPageBase64(encoded)).toEqual(source);
    expect(encodeFactoryPageBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });

  test("rejects empty, oversized, malformed, and non-canonical values", () => {
    expect(() => encodeFactoryPageBase64(new Uint8Array())).toThrow("1 to 32768");
    expect(() => encodeFactoryPageBase64(new Uint8Array(FACTORY_PAGE_BYTES_LIMIT + 1))).toThrow("1 to 32768");
    for (const value of [null, "", "AAA", "AA$=", "A===", "AB==", "AAB=", "A".repeat(43_692)]) {
      expect(() => decodeFactoryPageBase64(value)).toThrow();
    }
  });
});
