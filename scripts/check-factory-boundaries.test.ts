import { describe, expect, test } from "bun:test";
import {
  checkFactoryBoundaries,
  inspectRepositoryBoundaries,
  NODE_SERVICE_BOUNDARIES,
  nodeServiceViolations,
  runBoundaryCheck,
  runtimeImportClosure,
  type RequiredImport,
  type SourceInput,
} from "./check-factory-boundaries.ts";

const validationPath = "packages/@ezcorp/factory-sdk/src/validation.ts";
const expressionsPath = "packages/@ezcorp/factory-sdk/src/expressions.ts";
const safeFactory: SourceInput[] = [
  { path: validationPath, source: "export function validate(value: unknown) { return value !== undefined; }" },
  { path: expressionsPath, source: "export function add(a: number, b: number) { return a + b; }" },
];
const shared: SourceInput[] = [{
  path: "src/db/queries/audit-log.ts",
  source: "export async function insertTransactionalAuditEntry(db: unknown, id: string, actor: string | null, action: string, target: string, metadata: object) {}",
}];

describe("factory static boundaries", () => {
  test("accepts deterministic interpreted validation", () => {
    expect(checkFactoryBoundaries(safeFactory, shared, [])).toEqual([]);
  });

  test.each([
    ["new Function('return 1')", "Function"],
    ["eval('1')", "eval"],
    ["/unsafe/", "regular expressions"],
    ["new RegExp('unsafe')", "RegExp"],
    ["fetch('https://example.com')", "fetch"],
    ["Date.now()", "Date.now"],
    ["new Date()", "ambient time"],
    ["performance.now()", "performance.now"],
    ["Math.random()", "Math.random"],
    ["globalThis.eval('1')", "globalThis"],
    ["globalThis['eval']('1')", "computed access"],
    ["const Unsafe = (() => {}).constructor; new Unsafe('return 1')", "constructor"],
    ["Reflect.get(globalThis, 'Function')", "Reflect"],
    ["Bun.spawn(['true'])", "Bun.spawn"],
  ])("rejects controlled validator fault %s", (fault, expected) => {
    const files = safeFactory.map((file) => file.path === validationPath ? { ...file, source: `${file.source}\n${fault};` } : file);
    const violations = checkFactoryBoundaries(files, shared);
    expect(violations.some((violation) => violation.rule === "validator-code-generation" && violation.message.includes(expected))).toBe(true);
  });

  test("rejects a controlled forbidden runtime-module import", () => {
    const files = safeFactory.map((file) => file.path === expressionsPath ? { ...file, source: 'import { runInNewContext } from "node:vm";\n' + file.source } : file);
    expect(checkFactoryBoundaries(files, shared)).toContainEqual(expect.objectContaining({ rule: "validator-code-generation" }));
  });

  test("F13 rejects an injected duplicate of a real shared signature", () => {
    const duplicate = {
      path: "packages/@ezcorp/factory-sdk/src/compiler.ts",
      source: "function insertTransactionalAuditEntry(db: unknown, id: string, actor: string | null, action: string, target: string, metadata: object) {}",
    };
    expect(checkFactoryBoundaries([...safeFactory, duplicate], shared)).toContainEqual(expect.objectContaining({
      path: duplicate.path,
      rule: "f13-duplicate",
    }));
  });

  test("F13 rejects an injected duplicate shared class API", () => {
    const sharedClass = {
      path: "src/extensions/v4/deliveries.ts",
      source: "export class ExtensionDeliveryQueue { constructor(db: unknown) {} async enqueue(input: unknown, now = new Date()) {} }",
    };
    const duplicate = {
      path: "src/factory/deliveries.ts",
      source: "class ExtensionDeliveryQueue { constructor(db: unknown) {} async enqueue(input: unknown, now = new Date()) {} }",
    };
    expect(checkFactoryBoundaries([...safeFactory, duplicate], [...shared, sharedClass]))
      .toContainEqual(expect.objectContaining({ path: duplicate.path, rule: "f13-duplicate" }));
  });

  test("validator rules follow local imports so a helper cannot hide code generation", () => {
    const helper = { path: "packages/@ezcorp/factory-sdk/src/validator-helper.ts", source: "export const generate = () => Reflect.construct(Function, ['return 1']);" };
    const files = safeFactory.map((file) => file.path === validationPath ? { ...file, source: 'import { generate } from "./validator-helper";\n' + file.source } : file);
    const validatorClosure = new Set([validationPath, expressionsPath, helper.path]);
    expect(checkFactoryBoundaries([...files, helper], shared, [], validatorClosure))
      .toContainEqual(expect.objectContaining({ path: helper.path, rule: "validator-code-generation" }));
  });

  test("F13 distinguishes overload shape instead of banning a name alone", () => {
    const distinct = { path: "packages/@ezcorp/factory-sdk/src/compiler.ts", source: "function insertTransactionalAuditEntry(value: unknown) {}" };
    expect(checkFactoryBoundaries([...safeFactory, distinct], shared, [])).toEqual([]);
  });

  test("F13 requires each declared shared-module import", () => {
    const requirements: RequiredImport[] = [{
      factoryPath: "packages/@ezcorp/factory-sdk/src/compiler.ts",
      sharedModule: "src/extensions/v4/blobs.ts",
    }];
    const compiler = { path: requirements[0]!.factoryPath, source: "export const compile = () => true;" };
    expect(checkFactoryBoundaries([...safeFactory, compiler], shared, requirements)).toContainEqual(expect.objectContaining({ rule: "f13-required-import" }));

    compiler.source = 'import { digestObject } from "../../../../src/extensions/v4/blobs";\nexport const compile = () => digestObject({});';
    expect(checkFactoryBoundaries([...safeFactory, compiler], shared, requirements)).toEqual([]);
  });

  test("F13 resolves a workspace package specifier to its entry point", () => {
    const requirements: RequiredImport[] = [{
      factoryPath: "src/factory/runner/attempt-runtime.ts",
      sharedModule: "packages/@ezcorp/extension-runner/src/index.ts",
    }];
    const runtime = { path: requirements[0]!.factoryPath, source: 'import { executionLimits } from "./limits";\nexport const open = () => executionLimits;' };
    expect(checkFactoryBoundaries([...safeFactory, runtime], shared, requirements)).toContainEqual(expect.objectContaining({ rule: "f13-required-import", path: requirements[0]!.factoryPath }));

    runtime.source = 'import { configuredRunnerDevices } from "@ezcorp/extension-runner";\nexport const open = () => configuredRunnerDevices([]);';
    expect(checkFactoryBoundaries([...safeFactory, runtime], shared, requirements)).toEqual([]);
  });

  test("F13 fails when a declared factory module is absent", () => {
    expect(checkFactoryBoundaries(safeFactory, shared, [{ factoryPath: "src/factory/release.ts", sharedModule: "src/extensions/v4/blobs.ts" }]))
      .toContainEqual(expect.objectContaining({ rule: "f13-required-import", message: "factory module is missing" }));
  });

  test("inspects the real factory module graph and reports through the CLI seam", async () => {
    await expect(inspectRepositoryBoundaries()).resolves.toEqual([]);
    const output: string[] = [];
    expect(await runBoundaryCheck({ log: { log: (value) => output.push(String(value)), error: (value) => output.push(String(value)) } })).toBe(0);
    expect(output).toEqual(["Factory boundary checks passed (F07 deterministic validator, F13 shared-module reuse, and Node service links)."]);
  });

  test("the CLI seam returns failure and prints every violation", async () => {
    const output: string[] = [];
    const violation = { path: "src/factory/duplicate.ts", line: 7, rule: "f13-duplicate" as const, message: "duplicate" };
    expect(await runBoundaryCheck({
      inspect: async () => [violation],
      log: { log: (value) => output.push(String(value)), error: (value) => output.push(String(value)) },
    })).toBe(1);
    expect(output).toEqual(["src/factory/duplicate.ts:7 [f13-duplicate] duplicate"]);
  });
});

/** An in-memory repository: repo-relative path to source. */
function reader(files: Record<string, string>): (path: string) => string | undefined {
  return (path) => files[path];
}

const poolEntry = "src/factory/pool/service-server.ts";
const connection = "src/db/connection.ts";

describe("Node service links", () => {
  test("the rule guards the pool service against the Bun database driver", () => {
    expect(NODE_SERVICE_BOUNDARIES).toContainEqual(expect.objectContaining({ entry: poolEntry, forbidden: [connection] }));
  });

  test("rejects a deliberate violation and names the chain, through a dynamic import two hops away", () => {
    const files = reader({
      [poolEntry]: 'import { routes } from "./service-routes";\nexport const server = routes;',
      "src/factory/pool/service-routes.ts": 'export { limits as routes } from "../checkpoint-barrier";',
      "src/factory/checkpoint-barrier.ts": 'import { rows } from "../db/queries/extension-releases";\nexport const limits = rows;',
      "src/db/queries/extension-releases.ts": 'export async function rows() { return (await import("../connection")).getDb(); }',
      [connection]: 'import { SQL } from "bun";\nexport function getDb() { return SQL; }',
    });
    expect(nodeServiceViolations(undefined, files)).toEqual([{
      path: poolEntry,
      line: 1,
      rule: "node-service-link",
      message: `reaches ${connection}, which links the Bun SQL driver that a Node bundle cannot load: ${poolEntry} -> src/factory/pool/service-routes.ts -> src/factory/checkpoint-barrier.ts -> src/db/queries/extension-releases.ts -> ${connection}`,
    }]);
  });

  test("accepts a leaf module, and a type import links nothing", () => {
    const files = reader({
      [poolEntry]: 'import { LIMITS } from "../checkpoint-limits";\nimport type { Db } from "../../db/connection";\nimport { type Other } from "../../db/connection";\nexport type { Db, Other };\nexport const server = LIMITS;',
      "src/factory/checkpoint-limits.ts": "export const LIMITS = 1;",
      [connection]: 'import { SQL } from "bun";',
    });
    expect(nodeServiceViolations(undefined, files)).toEqual([]);
    expect(runtimeImportClosure([poolEntry], files).files).toEqual(["src/factory/checkpoint-limits.ts", poolEntry]);
  });

  test("a type-only re-export links nothing; a value re-export, an index module, and a bare package do", () => {
    const files = reader({
      "src/a.ts": 'export type { T } from "./types";\nexport { v } from "./lib";\nimport "node:fs";\nimport { x } from "./lib/index.js";\nimport "./missing";',
      "src/types.ts": "export type T = 1;",
      "src/lib/index.ts": 'import { SQL } from "bun";\nexport const v = 1, x = SQL;',
    });
    const closure = runtimeImportClosure(["src/a.ts"], files);
    expect(closure.files).toEqual(["src/a.ts", "src/lib/index.ts"]);
    expect(Object.fromEntries(closure.bare)).toEqual({ "node:fs": ["src/a.ts"], bun: ["src/lib/index.ts"] });
    expect(closure.importedBy.get("src/lib/index.ts")).toBe("src/a.ts");
  });

  test("a missing entry is a violation, not a silent pass", () => {
    expect(nodeServiceViolations([{ entry: "src/gone.ts", forbidden: [connection], reason: "r" }], reader({}))).toEqual([
      { path: "src/gone.ts", line: 1, rule: "node-service-link", message: "Node service entry is missing" },
    ]);
  });
});
