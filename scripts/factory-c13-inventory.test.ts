import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  REQUIRED_SHARED_IMPORTS,
  SHARED_REUSE_MODULES,
  checkFactoryBoundaries,
  type RequiredImport,
  type SourceInput,
} from "./check-factory-boundaries.ts";

/**
 * C13/F13 inventory COMPLETENESS.
 *
 * `checkFactoryBoundaries` proves that every DECLARED requirement holds. It
 * cannot see a factory module that imports a shared module nobody declared —
 * exactly the shape the plan asks W18 to verify: "the accumulated C13 inventory
 * covers every shared module the integrated factory modules import today".
 *
 * This derives the requirement from the real import graph instead of a written
 * list, so a work package that starts reusing a shared module without appending
 * its row is rejected rather than silently un-gated.
 */
const FACTORY_ROOTS = [
  "packages/@ezcorp/factory-sdk/src",
  "src/factory",
  "web/src/lib/factory",
  "web/src/routes/api/factories",
] as const;

function factorySourcePaths(): string[] {
  return FACTORY_ROOTS.flatMap((root) =>
    [...new Glob("**/*.ts").scanSync({ cwd: root })]
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
      .map((path) => `${root}/${path}`),
  ).sort();
}

/** Repo-relative target of a relative import specifier, `.ts` implied. */
export function resolveImport(fromPath: string, specifier: string): string {
  const absolute = resolve(process.cwd(), fromPath, "..", specifier);
  const withExtension = absolute.endsWith(".ts") ? absolute : `${absolute}.ts`;
  return relative(process.cwd(), withExtension).replaceAll("\\", "/");
}

/** Every (factory file -> shared module) edge the source actually imports. */
export function sharedImportEdges(
  files: readonly SourceInput[],
  sharedModules: readonly string[],
): RequiredImport[] {
  const shared = new Set(sharedModules);
  const edges: RequiredImport[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
      const target = resolveImport(file.path, match[1]!);
      if (shared.has(target)) edges.push({ factoryPath: file.path, sharedModule: target });
    }
  }
  return edges;
}

/** Edges the accumulated inventory does not declare. */
export function undeclaredSharedImports(
  edges: readonly RequiredImport[],
  declared: readonly RequiredImport[],
): string[] {
  const known = new Set(declared.map((entry) => `${entry.factoryPath}::${entry.sharedModule}`));
  return [...new Set(edges
    .filter((edge) => !known.has(`${edge.factoryPath}::${edge.sharedModule}`))
    .map((edge) => `${edge.factoryPath} imports C13 shared module ${edge.sharedModule} without a REQUIRED_SHARED_IMPORTS row`))].sort();
}

async function factoryFiles(): Promise<SourceInput[]> {
  const paths = factorySourcePaths();
  return Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
}

describe("C13 shared-module inventory", () => {
  test("names only shared modules that exist, because a typo reds the whole gate", async () => {
    for (const module of SHARED_REUSE_MODULES) {
      expect(await Bun.file(module).exists(), `SHARED_REUSE_MODULES names a missing file: ${module}`).toBe(true);
    }
    expect(new Set(SHARED_REUSE_MODULES).size).toBe(SHARED_REUSE_MODULES.length);
  });

  test("every declared requirement names a real factory module and a listed shared module", async () => {
    const shared = new Set<string>(SHARED_REUSE_MODULES);
    for (const requirement of REQUIRED_SHARED_IMPORTS) {
      expect(await Bun.file(requirement.factoryPath).exists(), `declared factory module is missing: ${requirement.factoryPath}`).toBe(true);
      expect(shared, `${requirement.sharedModule} is required but absent from SHARED_REUSE_MODULES`).toContain(requirement.sharedModule);
    }
  });

  test("the scan sees the real integrated factory graph, not an empty set", async () => {
    const files = await factoryFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(sharedImportEdges(files, SHARED_REUSE_MODULES).length).toBeGreaterThan(0);
  });

  test("every shared module the integrated factory modules import today is declared", async () => {
    const edges = sharedImportEdges(await factoryFiles(), SHARED_REUSE_MODULES);
    expect(undeclaredSharedImports(edges, REQUIRED_SHARED_IMPORTS)).toEqual([]);
  });

  test("an undeclared reuse edge is reported, and a declared one is not", () => {
    const declared = [{ factoryPath: "src/factory/records.ts", sharedModule: "src/extensions/v4/blobs.ts" }];
    const edges = [
      { factoryPath: "src/factory/records.ts", sharedModule: "src/extensions/v4/blobs.ts" },
      { factoryPath: "src/factory/newcomer.ts", sharedModule: "src/extensions/v4/blobs.ts" },
    ];
    expect(undeclaredSharedImports(edges, declared)).toEqual([
      "src/factory/newcomer.ts imports C13 shared module src/extensions/v4/blobs.ts without a REQUIRED_SHARED_IMPORTS row",
    ]);
  });

  test("the edge scan reads real import and re-export forms and ignores unrelated modules", () => {
    const files: SourceInput[] = [{
      path: "src/factory/sample.ts",
      source: [
        'import { a } from "../extensions/v4/blobs";',
        'import type { B } from "../extensions/v4/blobs.ts";',
        'export { c } from "../delivery-queue/durable-delivery-queue";',
        'import { d } from "node:path";',
        'import { e } from "./sibling";',
      ].join("\n"),
    }];
    const edges = sharedImportEdges(files, ["src/extensions/v4/blobs.ts", "src/delivery-queue/durable-delivery-queue.ts"]);
    expect(edges).toEqual([
      { factoryPath: "src/factory/sample.ts", sharedModule: "src/extensions/v4/blobs.ts" },
      { factoryPath: "src/factory/sample.ts", sharedModule: "src/extensions/v4/blobs.ts" },
      { factoryPath: "src/factory/sample.ts", sharedModule: "src/delivery-queue/durable-delivery-queue.ts" },
    ]);
  });
});

describe("C13 boundary checker rejects deliberate violations", () => {
  const validationPath = "packages/@ezcorp/factory-sdk/src/validation.ts";
  const expressionsPath = "packages/@ezcorp/factory-sdk/src/expressions.ts";
  const safeFactory: SourceInput[] = [
    { path: validationPath, source: "export function validate(value: unknown) { return value !== undefined; }" },
    { path: expressionsPath, source: "export function add(a: number, b: number) { return a + b; }" },
  ];

  test("a factory module that drops a real declared import is rejected", async () => {
    const requirement = REQUIRED_SHARED_IMPORTS.find((entry) => entry.factoryPath === "src/factory/records.ts")!;
    const original = await readFile(requirement.factoryPath, "utf8");
    const stripped = original.replace(
      new RegExp(`^.*from ["'][^"']*${requirement.sharedModule.replace("src/", "").replace(".ts", "").replace(/\//g, "\\/")}["'];?$`, "m"),
      "",
    );
    expect(stripped, "the deliberate fault removed nothing, so it proves nothing").not.toBe(original);
    const shared = await Promise.all(SHARED_REUSE_MODULES.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
    const violations = checkFactoryBoundaries(
      [...safeFactory, { path: requirement.factoryPath, source: stripped }],
      shared,
      [requirement],
    );
    expect(violations).toContainEqual(expect.objectContaining({
      path: requirement.factoryPath,
      rule: "f13-required-import",
      message: `must import the C13 shared module '${requirement.sharedModule}'`,
    }));
  });

  test("a duplicate of a real shared function signature is rejected", async () => {
    const auditLog = { path: "src/db/queries/audit-log.ts", source: await readFile("src/db/queries/audit-log.ts", "utf8") };
    const duplicate: SourceInput = {
      path: "src/factory/deliberate-duplicate.ts",
      source: "function insertTransactionalAuditEntry(db: unknown, id: string, actor: string | null, action: string, target: string, metadata: object) {}",
    };
    expect(checkFactoryBoundaries([...safeFactory, duplicate], [auditLog], [])).toContainEqual(expect.objectContaining({
      path: duplicate.path,
      rule: "f13-duplicate",
    }));
  });

  test("a differently shaped function with the same name is not a duplicate", async () => {
    const auditLog = { path: "src/db/queries/audit-log.ts", source: await readFile("src/db/queries/audit-log.ts", "utf8") };
    const distinct: SourceInput = {
      path: "src/factory/deliberate-distinct.ts",
      source: "function insertTransactionalAuditEntry(entry: unknown) {}",
    };
    expect(checkFactoryBoundaries([...safeFactory, distinct], [auditLog], [])).toEqual([]);
  });
});
