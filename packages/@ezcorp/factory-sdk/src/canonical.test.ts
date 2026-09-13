import { describe, expect, test } from "bun:test";
import { canonicalizeJson, isUnsignedDecimal, jsonEqual, unicodeLength, validateIJson } from "./canonical";

describe("canonical I-JSON", () => {
  test("canonicalizes keys, arrays, numbers, and negative zero", () => {
    expect(canonicalizeJson({ z: [true, null, -0], a: "😀" })).toBe('{"a":"😀","z":[true,null,0]}');
    expect(jsonEqual(-0, 0)).toBe(true);
    expect(jsonEqual({ a: [1] }, { a: [1] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(unicodeLength("a😀")).toBe(2);
  });

  test("rejects every non-I-JSON family", () => {
    expect(validateIJson(Number.NaN).ok).toBe(false);
    expect(validateIJson(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateIJson(9_007_199_254_740_992).ok).toBe(false);
    expect(validateIJson("\ud800").ok).toBe(false);
    expect(validateIJson({ "\udc00": true }).ok).toBe(false);
    expect(validateIJson(undefined).ok).toBe(false);
    expect(validateIJson(new Date()).ok).toBe(false);
    const sparse = new Array(1);
    expect(validateIJson(sparse).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateIJson(cyclic).ok).toBe(false);
    expect(() => canonicalizeJson(cyclic as never)).toThrow("cycles");
    let deep: unknown = null;
    for (let index = 0; index < 65; index += 1) deep = [deep];
    expect(validateIJson(deep).ok).toBe(false);
  });

  test("validates canonical unsigned decimals without regex", () => {
    expect(isUnsignedDecimal("0")).toBe(true);
    expect(isUnsignedDecimal("1200")).toBe(true);
    for (const invalid of ["", "00", "01", "-1", "1.0", " 1", "a"]) expect(isUnsignedDecimal(invalid)).toBe(false);
  });
});
