// slug.test.ts — full coverage for slug.ts
//
// Per spec test plan:
//   single char, 64 chars, 65 chars (reject), leading/trailing hyphen
//   (reject), uppercase (reject), empty (reject), special chars (reject),
//   pure digits (accept), double hyphens (accept per existing decision)

import { describe, expect, test } from "bun:test";

import {
  SLUG_MAX_LENGTH,
  SLUG_REGEX,
  assertValidSlug,
  isValidSlug,
} from "../slug";

describe("isValidSlug — accept cases", () => {
  test.each([
    ["a"],
    ["1"],
    ["ab"],
    ["a1"],
    ["weekly"],
    ["ad-hoc"],
    ["post-type"],
    ["a-b-c"],
    ["double--hyphen"], // accepted per locked decision
    ["x".repeat(SLUG_MAX_LENGTH)], // 64 chars exactly
    ["1234567890"], // pure digits
    ["0"], // single digit
  ] satisfies [string][])("accepts %p", (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });
});

describe("isValidSlug — reject cases", () => {
  test.each([
    [""], // empty
    ["-"], // single hyphen
    ["-leading"], // leading hyphen
    ["trailing-"], // trailing hyphen
    ["-a-"], // both
    ["A"], // uppercase
    ["Weekly"], // mixed case
    ["post_type"], // underscore
    ["post.type"], // dot
    ["post type"], // space
    ["post/type"], // slash
    ["a".repeat(SLUG_MAX_LENGTH + 1)], // 65 chars
    ["é"], // non-ASCII
    ["🎉"], // emoji
  ] satisfies [string][])("rejects %p", (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });

  test.each([
    [null],
    [undefined],
    [123],
    [true],
    [false],
    [{}],
    [[]],
    [{ slug: "weekly" }],
  ] satisfies [unknown][])("rejects non-string %p", (input) => {
    expect(isValidSlug(input)).toBe(false);
  });
});

describe("assertValidSlug", () => {
  test("returns void for valid slug", () => {
    expect(() => assertValidSlug("weekly")).not.toThrow();
  });

  test("throws on invalid slug with full regex in message", () => {
    expect(() => assertValidSlug("-bad")).toThrow(
      /Invalid slug "-bad" — must match \^\[a-z0-9\]/,
    );
  });

  test("throws on non-string input", () => {
    expect(() => assertValidSlug(42)).toThrow(/Invalid slug 42/);
  });

  test("throws on undefined", () => {
    expect(() => assertValidSlug(undefined)).toThrow(/Invalid slug/);
  });

  test("custom label is used in error message", () => {
    expect(() => assertValidSlug("BAD", "post type slug")).toThrow(
      /Invalid post type slug/,
    );
  });
});

describe("SLUG_REGEX export", () => {
  test("matches expected pattern source", () => {
    expect(SLUG_REGEX.source).toBe("^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$");
  });

  test("SLUG_MAX_LENGTH is 64", () => {
    expect(SLUG_MAX_LENGTH).toBe(64);
  });
});
