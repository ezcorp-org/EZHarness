import { test, expect, describe } from "bun:test";
import { toVectorLiteral } from "../memory/vector-utils";

describe("toVectorLiteral", () => {
  test("converts valid embedding to vector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("'[0.1,0.2,0.3]'::vector");
  });

  test("handles single element", () => {
    expect(toVectorLiteral([1.0])).toBe("'[1]'::vector");
  });

  test("handles negative values", () => {
    expect(toVectorLiteral([-0.5, 0.5])).toBe("'[-0.5,0.5]'::vector");
  });

  test("handles zero values", () => {
    expect(toVectorLiteral([0, 0, 0])).toBe("'[0,0,0]'::vector");
  });

  test("throws on empty array", () => {
    expect(() => toVectorLiteral([])).toThrow("array must not be empty");
  });

  test("throws on NaN", () => {
    expect(() => toVectorLiteral([NaN])).toThrow("finite numbers");
  });

  test("throws on Infinity", () => {
    expect(() => toVectorLiteral([Infinity])).toThrow("finite numbers");
  });

  test("throws on -Infinity", () => {
    expect(() => toVectorLiteral([-Infinity])).toThrow("finite numbers");
  });

  test("throws on non-number values", () => {
    expect(() => toVectorLiteral(["a" as any])).toThrow("finite numbers");
  });

  test("throws when NaN is mixed with valid values", () => {
    expect(() => toVectorLiteral([0.1, NaN, 0.3])).toThrow("finite numbers");
  });
});
