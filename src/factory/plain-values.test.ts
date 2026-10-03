import { describe, expect, test } from "bun:test";
import { factoryErrorCode, isPlainRecord } from "./plain-values";

describe("isPlainRecord", () => {
  test("accepts a plain object", () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord({})).toBe(true);
  });

  test("refuses null, arrays, and scalars", () => {
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord("x")).toBe(false);
    expect(isPlainRecord(1)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
  });
});

describe("factoryErrorCode", () => {
  test("returns a string code", () => {
    expect(factoryErrorCode(Object.assign(new Error("m"), { code: "factory_x" }))).toBe("factory_x");
  });

  test("returns undefined for a missing or non-string code, null, and undefined", () => {
    expect(factoryErrorCode(new Error("m"))).toBeUndefined();
    expect(factoryErrorCode({ code: 7 })).toBeUndefined();
    expect(factoryErrorCode(null)).toBeUndefined();
    expect(factoryErrorCode(undefined)).toBeUndefined();
  });
});
