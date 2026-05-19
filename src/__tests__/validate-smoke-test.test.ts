/**
 * Phase B — `validateSmokeTest` unit coverage.
 *
 * The smokeTest block is OPTIONAL in `validateManifestV2` (the 47
 * bundled extensions stay valid) but when present it must be
 * well-formed AND its `tool` must be a declared tool name.
 */

import { test, expect, describe } from "bun:test";
import { validateSmokeTest, validateManifestV2 } from "../extensions/manifest";

function run(smokeTest: unknown, declared: string[] = ["ping"]): string[] {
  const errors: string[] = [];
  validateSmokeTest(smokeTest, declared, errors);
  return errors;
}

describe("validateSmokeTest — direct", () => {
  test("valid block ⇒ no errors", () => {
    expect(
      run({
        tool: "ping",
        input: { message: "hi" },
        expect: { textIncludes: "ok", isError: false },
      }),
    ).toEqual([]);
  });

  test("valid with only isError ⇒ no errors", () => {
    expect(run({ tool: "ping", input: {}, expect: { isError: true } })).toEqual(
      [],
    );
  });

  test("non-object ⇒ error", () => {
    expect(run("nope")).toContain("smokeTest must be an object");
    expect(run([])).toContain("smokeTest must be an object");
    expect(run(null)).toContain("smokeTest must be an object");
  });

  test("missing tool ⇒ error", () => {
    const errs = run({ input: {}, expect: { isError: false } });
    expect(errs.some((e) => e.includes("smokeTest.tool is required"))).toBe(
      true,
    );
  });

  test("tool not declared ⇒ error naming declared set", () => {
    const errs = run(
      { tool: "frobnicate", input: {}, expect: { isError: false } },
      ["ping", "pong"],
    );
    expect(
      errs.some(
        (e) =>
          e.includes('smokeTest.tool "frobnicate" is not a declared tool') &&
          e.includes("ping, pong"),
      ),
    ).toBe(true);
  });

  test("tool not declared, empty declared set ⇒ <none>", () => {
    const errs = run({ tool: "ping", input: {}, expect: { isError: false } }, []);
    expect(errs.some((e) => e.includes("declared: <none>"))).toBe(true);
  });

  test("bad input (not object) ⇒ error", () => {
    expect(
      run({ tool: "ping", input: "x", expect: { isError: false } }),
    ).toContain("smokeTest.input is required and must be an object");
    expect(
      run({ tool: "ping", input: [], expect: { isError: false } }),
    ).toContain("smokeTest.input is required and must be an object");
  });

  test("missing expect ⇒ error", () => {
    expect(run({ tool: "ping", input: {} })).toContain(
      "smokeTest.expect is required and must be an object",
    );
  });

  test("expect with bad isError type ⇒ error", () => {
    expect(
      run({ tool: "ping", input: {}, expect: { isError: "true" } }),
    ).toContain("smokeTest.expect.isError must be a boolean when set");
  });

  test("expect with bad textIncludes type ⇒ error", () => {
    expect(
      run({ tool: "ping", input: {}, expect: { textIncludes: 42 } }),
    ).toContain("smokeTest.expect.textIncludes must be a string when set");
  });

  test("expect with neither isError nor textIncludes ⇒ error", () => {
    expect(run({ tool: "ping", input: {}, expect: {} })).toContain(
      "smokeTest.expect must declare at least one of `isError` or `textIncludes`",
    );
  });
});

describe("validateManifestV2 — smokeTest integration", () => {
  const base = {
    schemaVersion: 2,
    name: "smoke-ext",
    version: "1.0.0",
    description: "x",
    author: { name: "t" },
    entrypoint: "./index.ts",
    tools: [
      { name: "ping", description: "p", inputSchema: { type: "object" } },
    ],
    permissions: {},
  };

  test("manifest WITHOUT smokeTest is still valid (bundled corpus)", () => {
    const r = validateManifestV2(base);
    expect(r.valid).toBe(true);
  });

  test("manifest with valid smokeTest ⇒ valid", () => {
    const r = validateManifestV2({
      ...base,
      smokeTest: {
        tool: "ping",
        input: { message: "x" },
        expect: { textIncludes: "ok" },
      },
    });
    expect(r.valid).toBe(true);
  });

  test("manifest with smokeTest targeting undeclared tool ⇒ invalid", () => {
    const r = validateManifestV2({
      ...base,
      smokeTest: {
        tool: "nope",
        input: {},
        expect: { isError: false },
      },
    });
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => e.includes('"nope" is not a declared tool')),
    ).toBe(true);
  });

  test("smokeTest cross-check sees declared tool names from m.tools", () => {
    const r = validateManifestV2({
      ...base,
      tools: [
        { name: "alpha", description: "a", inputSchema: { type: "object" } },
      ],
      smokeTest: { tool: "alpha", input: {}, expect: { isError: false } },
    });
    expect(r.valid).toBe(true);
  });
});
