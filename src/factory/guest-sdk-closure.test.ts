import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { factorySdkClosure, FactorySdkClosureError, relativeImports, unresolvedImports } from "./guest-sdk-closure";

const REPO = join(import.meta.dir, "..", "..");
const SDK = join(REPO, "packages/@ezcorp/factory-sdk/src");

/** An in-memory SDK directory: the reader sees only these files, and records what it was asked for. */
function fixture(modules: Readonly<Record<string, string>>) {
  const asked: string[] = [];
  const read = async (path: string) => {
    const name = path.slice(`${SDK}/`.length);
    asked.push(name);
    if (!(name in modules)) throw new Error(`ENOENT ${name}`);
    return modules[name]!;
  };
  return { asked, read };
}

describe("relativeImports", () => {
  test("names the flat file of every relative import form, and nothing else", () => {
    const source = [
      'import { a } from "./alpha.js";',
      "export * from './beta.js';",
      'import type { C } from "./gamma.ts";',
      'import "./side-effect.js";',
      'import schema from "./shape.schema.json" with { type: "json" };',
      'type Late = import("./late.js").Late;',
      'import { z } from "zod";',
      'import { up } from "../outside.js";',
    ].join("\n");
    expect(relativeImports(source)).toEqual(["alpha.ts", "beta.ts", "gamma.ts", "side-effect.ts", "shape.schema.json", "late.ts"]);
  });
});

describe("factorySdkClosure", () => {
  test("stages everything the seeds reach, transitively, rewritten for a flat workspace", async () => {
    const sdk = fixture({
      "entry.ts": 'import { b } from "./b.js";\nexport * from "./c.js";\ntype D = import("./d.js").D;',
      "b.ts": 'import shape from "./shape.schema.json" with { type: "json" };\nimport "./c.js";',
      "c.ts": "export const c = 1;",
      "d.ts": "export interface D { readonly d: true }",
      "shape.schema.json": '{"type":"object"}',
      "unused.ts": "export const unused = true;",
    });
    const files = await factorySdkClosure(SDK, { "guest.ts": 'import { entry } from "./entry.ts";\nimport { own } from "./own.ts";', "own.ts": "export const own = 1;", "icon.png": { data: "iVBORw0KGgo=" } }, sdk.read);
    expect(Object.keys(files).sort()).toEqual(["b.ts", "c.ts", "d.ts", "entry.ts", "shape.schema.json"]);
    expect(files["entry.ts"]).toBe('import { b } from "./b.ts";\nexport * from "./c.ts";\ntype D = import("./d.ts").D;');
    expect(files["b.ts"]).toBe('import shape from "./shape.schema.json" with { type: "json" };\nimport "./c.ts";');
    expect(files["shape.schema.json"]).toBe('{"type":"object"}');
    // A seed is the guest's own file and is never looked up; a module is read once however often it is imported.
    expect(sdk.asked.sort()).toEqual(["b.ts", "c.ts", "d.ts", "entry.ts", "shape.schema.json"]);
    expect(unresolvedImports({ ...files, "guest.ts": "", "own.ts": "" })).toEqual([]);
  });

  test("an import the SDK does not have is refused by name, with the file that imports it", async () => {
    const sdk = fixture({ "entry.ts": 'export * from "./gone.js";' });
    const refused = await factorySdkClosure(SDK, { "guest.ts": 'import "./entry.ts";' }, sdk.read).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FactorySdkClosureError);
    expect(refused).toMatchObject({ module: "gone.ts", importedBy: "entry.ts", message: "factory_sdk_closure_missing: entry.ts imports ./gone.ts, which the SDK does not have" });
  });

  test("the real SDK: the staging client's closure reaches every module types.ts imports, console-types.ts included", async () => {
    const files = await factorySdkClosure(SDK, { "guest.ts": 'import { createFactoryGuestStaging } from "./guest-materials.ts";' });
    expect(unresolvedImports({ ...files, "guest.ts": "" })).toEqual([]);
    expect(files).toHaveProperty(["console-types.ts"]);
    expect(Object.keys(files).filter(name => name.endsWith(".schema.json")).length).toBeGreaterThan(0);
  });
});

describe("unresolvedImports", () => {
  test("names each relative import that no staged file answers", () => {
    expect(unresolvedImports({ "a.ts": 'import "./b.js";\nimport "./c.ts";', "b.ts": "" })).toEqual(["a.ts -> c.ts"]);
    // An encoded binary imports nothing, even when its data happens to read like an import.
    expect(unresolvedImports({ "icon.png": { data: 'from "./missing.js"' } })).toEqual([]);
  });
});

// The W14 lane guest stages the same SDK client; it must be as complete as the graph guest.
test("every relative import in the staged factory-services lane guest names a staged file", async () => {
  const { guestSource } = await import(join(REPO, "web/e2e/factory-services/guest.ts"));
  const files = await guestSource(REPO) as Record<string, string>;
  expect(unresolvedImports(files)).toEqual([]);
  expect(files).toHaveProperty(["console-types.ts"]);
});

/** Every non-test TypeScript source under `roots`, repository-relative; the SDK's own tree is not a copier of itself. */
function sources(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (relative(REPO, path) === "packages/@ezcorp/factory-sdk") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !/\.(test|spec|d)\.ts$/.test(entry.name)) found.push(relative(REPO, path));
    }
  };
  for (const root of roots) walk(join(REPO, root));
  return found.sort();
}

/**
 * Names the SDK source directory in any form a reader would: a joined path (`factory-sdk/src`), path
 * segments (`"factory-sdk", "src"`), or an import path. Deliberately broader than what a packager looks like.
 */
const SDK_SOURCE_DIRECTORY = /factory-sdk(?:\/|\\{1,2}|["'`]\s*,\s*["'`])src(?![A-Za-z0-9_])/;

// Any source that names the SDK source directory is a candidate packager. The TypeScript packagers must
// follow the SDK's imports through factorySdkClosure, so no fixed module list (the W14 regression, three
// times) can come back. Every other candidate is named here with the reason it is not one. An unknown
// candidate fails this test by path, however it is written.
test("every source that names the SDK source directory stages SDK modules through the closure helper, or is named", () => {
  const throughClosure = ["scripts/factory-graph-proof/guest-package.ts", "src/factory/reference-code/guest.ts", "web/e2e/factory-services/guest.ts"];
  // Python guests stage generated JSON schemas by name and import no TypeScript; the reference-data pack's
  // import-closure guard (reference-data/guest.test.ts) covers their Python modules.
  const schemasOnly = ["src/factory/reference-data/guest.ts", "src/factory/runner/python-guest.ts"];
  // Read the SDK tree to check it, and stage nothing into a guest.
  const notPackagers = [
    "scripts/check-factory-boundaries.ts", // scans the SDK's sources for boundary rules
    "scripts/check-schema-generate-drift.ts", // compares the generated schemas with their generator
    "scripts/coverage-config.ts", // names the SDK sources in the coverage source set
  ];
  const candidates = sources(["scripts", "src", "web/e2e", "web/src", "packages", "extensions", "worker"])
    .filter(path => SDK_SOURCE_DIRECTORY.test(readFileSync(join(REPO, path), "utf8")));
  expect(candidates).toEqual([...throughClosure, ...schemasOnly, ...notPackagers].sort());
  for (const path of throughClosure) expect(readFileSync(join(REPO, path), "utf8")).toContain("factorySdkClosure(");
  // A schemas-only packager reads no SDK TypeScript module.
  for (const path of schemasOnly) expect(readFileSync(join(REPO, path), "utf8")).not.toMatch(/factory-sdk\/src\/[A-Za-z-]+\.ts/);
});

test("the SDK-directory pattern recognises every way a source can name it, and nothing near it", () => {
  for (const named of ['join(root, "packages/@ezcorp/factory-sdk/src")', '["packages", "@ezcorp", "factory-sdk", "src"].join("/")', 'from "../../packages/@ezcorp/factory-sdk/src/index"', "join(repo, 'factory-sdk', 'src', name)", "packages\\@ezcorp\\factory-sdk\\src"]) {
    expect(SDK_SOURCE_DIRECTORY.test(named)).toBe(true);
  }
  for (const other of ['from "@ezcorp/factory-sdk"', '"packages/@ezcorp/factory-sdk/dist"', '"factory-sdk/srcmap"', '"factory-sdk-types.ts"']) expect(SDK_SOURCE_DIRECTORY.test(other)).toBe(false);
});
