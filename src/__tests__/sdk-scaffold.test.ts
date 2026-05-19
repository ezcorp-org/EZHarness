// Unit tests for the pure scaffolder.
//
// `scaffoldExtension({ name, type, description })` is consumed by:
//   - `bun run ext:init` CLI (host's `src/extensions/sdk/init.ts`)
//   - `extension-author` bundled extension's `create_extension` tool
//
// These tests pin the file set per type and validate that each
// scaffolded manifest passes `validateManifestV2` — the same gate the
// host's installer runs at install time. If this test goes red, the
// CLI scaffold is broken AND the bundled extension produces drafts
// that would fail at install.

import { test, expect, describe } from "bun:test";
import { scaffoldExtension, EXT_TYPES } from "@ezcorp/sdk";
import { validateManifestV2 } from "../extensions/manifest";

// The TS template ships as TypeScript source. To validate it through
// `validateManifestV2` we evaluate the manifest body to JS-equivalent
// shape without an actual TS compile step — the `defineExtension`
// import becomes a passthrough function. This mirrors the approach in
// `ts-manifest-integration.test.ts` (which has been the source-of-truth
// pattern since the v2 manifest landed).
function evalManifestSrc(src: string): unknown {
  // Replace the `defineExtension` and (for tool/multi templates) the
  // `handleRequest` import with stubs so the IIFE evaluates.
  const body = src
    .replace(/^import \{ defineExtension \}.*$/m, "const defineExtension = (x) => x;")
    .replace(/^import \{ handleRequest \}.*$/m, "const handleRequest = () => null;")
    .replace(/^export default /m, "return ");
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

describe("scaffoldExtension — file set per type", () => {
  test("tool produces manifest + index + test + readme + tsconfig + package.json + .gitignore", () => {
    const { files } = scaffoldExtension({ name: "weather", type: "tool", description: "x" });
    expect(Object.keys(files).sort()).toEqual(
      [".gitignore", "README.md", "ezcorp.config.ts", "index.test.ts", "index.ts", "package.json", "tsconfig.json"].sort(),
    );
  });

  test("skill omits index.ts (prompt-based)", () => {
    const { files } = scaffoldExtension({ name: "wisdom", type: "skill", description: "x" });
    expect(files["index.ts"]).toBeUndefined();
    expect(files["ezcorp.config.ts"]).toBeDefined();
    expect(files["index.test.ts"]).toBeDefined();
  });

  test("agent omits index.ts (persona-only)", () => {
    const { files } = scaffoldExtension({ name: "ducky", type: "agent", description: "x" });
    expect(files["index.ts"]).toBeUndefined();
    expect(files["ezcorp.config.ts"]).toBeDefined();
  });

  test("multi includes index.ts (has tools)", () => {
    const { files } = scaffoldExtension({ name: "combo", type: "multi", description: "x" });
    expect(files["index.ts"]).toBeDefined();
    expect(files["ezcorp.config.ts"]).toBeDefined();
  });
});

describe("scaffoldExtension — manifest validates", () => {
  for (const type of EXT_TYPES) {
    test(`${type} manifest passes validateManifestV2`, () => {
      const { files } = scaffoldExtension({ name: `ext-${type}`, type, description: "scaffold smoke" });
      const manifest = evalManifestSrc(files["ezcorp.config.ts"]!);
      const result = validateManifestV2(manifest);
      if (!result.valid) {
        // Surface the errors in the failure message — easier to debug.
        throw new Error(`${type} manifest invalid: ${result.errors.join(", ")}`);
      }
      expect(result.valid).toBe(true);
    });
  }
});

describe("scaffoldExtension — name validation", () => {
  test("empty name throws", () => {
    expect(() => scaffoldExtension({ name: "", type: "tool", description: "x" })).toThrow();
  });

  test("UPPERCASE name throws (NAME_REGEX requires lowercase start)", () => {
    expect(() => scaffoldExtension({ name: "MyExt", type: "tool", description: "x" })).toThrow(/NAME_REGEX|match/);
  });

  test("name with .. throws", () => {
    expect(() => scaffoldExtension({ name: "ev..il", type: "tool", description: "x" })).toThrow();
  });

  test("name with slash throws", () => {
    expect(() => scaffoldExtension({ name: "a/b", type: "tool", description: "x" })).toThrow();
  });

  test("65-char name throws (max 64)", () => {
    expect(() => scaffoldExtension({ name: "a".repeat(65), type: "tool", description: "x" })).toThrow();
  });

  test("64-char name accepted", () => {
    const out = scaffoldExtension({ name: "a".repeat(64), type: "tool", description: "x" });
    expect(out.files["ezcorp.config.ts"]).toContain("a".repeat(64));
  });

  test("dotted + dashed + underscored name accepted", () => {
    const out = scaffoldExtension({ name: "my-ext_v1.beta", type: "skill", description: "x" });
    expect(out.files["ezcorp.config.ts"]).toContain("my-ext_v1.beta");
  });
});

describe("scaffoldExtension — type validation", () => {
  test("unknown type throws", () => {
    expect(() =>
      scaffoldExtension({ name: "x", type: "weird" as unknown as "tool", description: "x" }),
    ).toThrow(/type must be one of/);
  });
});

describe("scaffoldExtension — description handling", () => {
  test("description is interpolated into manifest", () => {
    const { files } = scaffoldExtension({ name: "weather", type: "tool", description: "Returns weather" });
    expect(files["ezcorp.config.ts"]).toContain("Returns weather");
  });

  test("description is interpolated into README", () => {
    const { files } = scaffoldExtension({ name: "weather", type: "agent", description: "A weather agent" });
    expect(files["README.md"]).toContain("A weather agent");
  });
});

describe("scaffoldExtension — package.json shape", () => {
  test("declares @ezcorp/sdk dependency", () => {
    const { files } = scaffoldExtension({ name: "x", type: "tool", description: "x" });
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.dependencies["@ezcorp/sdk"]).toBeDefined();
  });

  test("name + description match scaffold inputs", () => {
    const { files } = scaffoldExtension({ name: "weather", type: "tool", description: "Weather queries" });
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.name).toBe("weather");
    expect(pkg.description).toBe("Weather queries");
  });

  test("package marked private to prevent accidental publish", () => {
    const { files } = scaffoldExtension({ name: "x", type: "tool", description: "x" });
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.private).toBe(true);
  });
});

describe("scaffoldExtension — tsconfig shape", () => {
  test("standalone (no extends) so authors can install outside the workspace", () => {
    const { files } = scaffoldExtension({ name: "x", type: "tool", description: "x" });
    const tsconfig = JSON.parse(files["tsconfig.json"]!);
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.types).toContain("bun");
  });
});
