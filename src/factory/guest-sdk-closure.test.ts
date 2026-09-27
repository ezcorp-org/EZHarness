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

/** Every non-test TypeScript source under `roots`, repository-relative. */
function sources(roots: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts")) found.push(relative(REPO, path));
    }
  };
  for (const root of roots) walk(join(REPO, root));
  return found.sort();
}

// A guest packager reads from the SDK source directory and stages what it read into a guest workspace. The
// TypeScript ones must follow the SDK's imports through factorySdkClosure, so no fixed module list (the
// W14 regression, twice) can come back. A packager this test does not know fails it by path.
test("every packager that copies SDK sources into a guest stages them through the closure helper", () => {
  const throughClosure = ["scripts/factory-graph-proof/guest-package.ts", "src/factory/reference-code/guest.ts", "web/e2e/factory-services/guest.ts"];
  // Python guests stage generated JSON schemas by name and import no TypeScript; the reference-data pack's
  // import-closure guard (reference-data/guest.test.ts) covers their Python modules.
  const schemasOnly = ["src/factory/reference-data/guest.ts", "src/factory/runner/python-guest.ts"];
  const packagers = sources(["scripts", "src", "web/e2e", "web/src"]).filter(path => {
    const text = readFileSync(join(REPO, path), "utf8");
    // It names the SDK source directory and builds a guest workspace: a feature test, a staged files record, or the helper.
    return text.includes("packages/@ezcorp/factory-sdk/src") && (text.includes("feature.test.ts") || text.includes("files[") || text.includes("factorySdkClosure("));
  });
  expect(packagers).toEqual([...throughClosure, ...schemasOnly].sort());
  for (const path of throughClosure) expect(readFileSync(join(REPO, path), "utf8")).toContain("factorySdkClosure(");
  // A schemas-only packager stages no SDK TypeScript module.
  for (const path of schemasOnly) expect(readFileSync(join(REPO, path), "utf8")).not.toMatch(/factory-sdk\/src\/[A-Za-z-]+\.ts/);
});
