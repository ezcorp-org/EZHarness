import { test, expect, describe } from "bun:test";
import { scaffoldExtension, EXT_TYPES } from "@ezcorp/sdk";
import { validateManifest } from "@ezcorp/extension-contract";

function evalManifestSrc(src: string) {
  const prefix = "export default validateManifest(";
  return validateManifest(JSON.parse(src.slice(src.indexOf(prefix) + prefix.length, src.lastIndexOf(");"))));
}

describe("scaffoldExtension — file set per type", () => {
  test("tool produces manifest + index + test + readme + tsconfig + package.json + .gitignore", () => {
    const { files } = scaffoldExtension({ name: "weather", type: "tool", description: "x" });
    expect(Object.keys(files).sort()).toEqual(
      [".gitignore", "README.md", "ezcorp.config.ts", "extension.test.ts", "extension.ts", "package.json", "tsconfig.json"].sort(),
    );
  });

  test("skill serves isolated discovery (prompt-based)", () => {
    const { files } = scaffoldExtension({ name: "wisdom", type: "skill", description: "x" });
    expect(files["extension.ts"]).toContain("serve(extension)");
    expect(files["ezcorp.config.ts"]).toBeDefined();
    expect(files["extension.test.ts"]).toBeDefined();
  });

  test("agent serves isolated discovery (persona-only)", () => {
    const { files } = scaffoldExtension({ name: "ducky", type: "agent", description: "x" });
    expect(files["extension.ts"]).toContain("serve(extension)");
    expect(files["ezcorp.config.ts"]).toBeDefined();
  });

  test("multi includes extension.ts (has tools)", () => {
    const { files } = scaffoldExtension({ name: "combo", type: "multi", description: "x" });
    expect(files["extension.ts"]).toBeDefined();
    expect(files["ezcorp.config.ts"]).toBeDefined();
  });
});

describe("scaffoldExtension — manifest validates", () => {
  for (const type of EXT_TYPES) {
    test(`${type} manifest passes canonical v4 validation`, () => {
      const { files } = scaffoldExtension({ name: `ext-${type}`, type, description: "scaffold smoke" });
      const manifest = evalManifestSrc(files["ezcorp.config.ts"]!);
      expect(manifest.schemaVersion).toBe(4);
      expect(manifest.permissions).toEqual({});
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
  test("declares an exact trusted SDK peer", () => {
    const { files } = scaffoldExtension({ name: "x", type: "tool", description: "x" });
    const pkg = JSON.parse(files["package.json"]!);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies["@ezcorp/sdk"]).toBe("0.1.0");
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
