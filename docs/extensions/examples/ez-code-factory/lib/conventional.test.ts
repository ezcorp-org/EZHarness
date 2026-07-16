import { test, expect, describe } from "bun:test";
import { isTitle, tightenTitle, RELEASE_TYPE_RULE } from "./conventional";

describe("isTitle", () => {
  test("accepts a conventional subject with a valid type", () => {
    expect(isTitle("feat: add a flag")).toBe(true);
    expect(isTitle("fix(daemon): correct a race")).toBe(true);
    expect(isTitle("refactor(pipeline)!: rewrite executor")).toBe(true);
  });
  test("rejects an unknown type", () => {
    expect(isTitle("wibble: do a thing")).toBe(false);
  });
  test("rejects a non-conventional title", () => {
    expect(isTitle("just some words")).toBe(false);
  });
  test("trims before matching", () => {
    expect(isTitle("  feat: trimmed  ")).toBe(true);
  });
});

describe("tightenTitle", () => {
  test("empty → empty", () => {
    expect(tightenTitle("   ")).toBe("");
  });
  test("already-conventional passes through (trimmed)", () => {
    expect(tightenTitle("  fix: keep me  ")).toBe("fix: keep me");
  });
  test("documentation wording → docs", () => {
    expect(tightenTitle("update the README")).toBe("docs: update the README");
    expect(tightenTitle("documentation tweaks")).toBe("docs: documentation tweaks");
    expect(tightenTitle("docs polish")).toBe("docs: docs polish");
  });
  test("feature wording → feat", () => {
    expect(tightenTitle("add a new endpoint")).toBe("feat: add a new endpoint");
    expect(tightenTitle("introduce caching")).toBe("feat: introduce caching");
    expect(tightenTitle("New dashboard")).toBe("feat: New dashboard");
    expect(tightenTitle("teach the thing new tricks")).toBe("feat: teach the thing new tricks");
  });
  test("fix wording → fix", () => {
    expect(tightenTitle("resolve the crash")).toBe("fix: resolve the crash");
    expect(tightenTitle("repair the parser")).toBe("fix: repair the parser");
  });
  test("product-impact but neither feature nor fix wording → fix", () => {
    // "behavior" is product-impact; no feature/fix prefix → inferReleaseType → fix.
    expect(tightenTitle("tweak the CLI behavior")).toBe("fix: tweak the CLI behavior");
  });
  test("no signal → chore", () => {
    expect(tightenTitle("bump the vendored deps")).toBe("chore: bump the vendored deps");
  });
  test("unknown type prefix is treated as bare and re-typed", () => {
    expect(tightenTitle("wibble: do a thing")).toBe("chore: wibble: do a thing");
  });
});

test("RELEASE_TYPE_RULE names feat/fix", () => {
  expect(RELEASE_TYPE_RULE).toContain("feat");
  expect(RELEASE_TYPE_RULE).toContain("fix");
});
