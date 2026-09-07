/**
 * Phase C — scaffolded tool/multi extensions are deterministic-gate
 * ready out of the box.
 *
 * - generated `ezcorp.config.ts` parses validateManifestV2 clean AND
 *   contains a valid `smokeTest` (cross-checked against a declared tool)
 * - generated `index.test.ts` has a REAL test (no `test.todo`)
 * - a freshly-scaffolded dir, written to disk, passes `verifyExtension`
 */

import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Scaffold into a tmp dir UNDER the worktree's gitignored `data/` so
// Bun's module resolution walks up to the repo `node_modules` and
// resolves `@ezcorp/sdk` (a workspace symlink) exactly as it does in
// production (`data/extensions/<name>/`). A bare `os.tmpdir()` dir has
// no node_modules on its resolution path and would fail to load the
// scaffold's `import ... from "@ezcorp/sdk"`.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAFFOLD_TMP_BASE = join(REPO_ROOT, "data", "scaffold-verify-tmp");

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => 1,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

const { scaffoldExtension } = await import("@ezcorp/sdk");
const { validateManifestV2, validateSmokeTest } = await import(
  "../extensions/manifest"
);
const { verifyExtension } = await import("../extensions/sdk/verify");
const { createTestExtension } = await import("../extensions/sdk/test-helpers");

function evalManifest(src: string): Record<string, unknown> {
  const body = src
    .replace(/^import \{ defineExtension \}.*$/m, "const defineExtension = (x) => x;")
    .replace(/^import \{ handleRequest \}.*$/m, "const handleRequest = () => null;")
    .replace(/^export default /m, "return ");
  // eslint-disable-next-line no-new-func
  return new Function(body)() as Record<string, unknown>;
}

describe("scaffold — smokeTest + real test (tool/multi)", () => {
  for (const type of ["tool", "multi"] as const) {
    test(`${type}: manifest valid AND contains a valid smokeTest`, () => {
      const { files } = scaffoldExtension({
        name: `gate-${type}`,
        type,
        description: "deterministic gate scaffold",
      });
      const manifest = evalManifest(files["ezcorp.config.ts"]!);

      // Whole-manifest validation (includes the smokeTest cross-check).
      const v = validateManifestV2(manifest);
      expect(v.valid).toBe(true);

      // smokeTest present + structurally valid against declared tools.
      expect(manifest.smokeTest).toBeDefined();
      const toolNames = (manifest.tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
      const errs: string[] = [];
      validateSmokeTest(manifest.smokeTest, toolNames, errs);
      expect(errs).toEqual([]);
      expect(toolNames).toContain(
        (manifest.smokeTest as { tool: string }).tool,
      );
    });

    test(`${type}: generated index.test.ts has a REAL test (no test.todo)`, () => {
      const { files } = scaffoldExtension({
        name: `gate-${type}-t`,
        type,
        description: "x",
      });
      const testSrc = files["index.test.ts"]!;
      expect(testSrc).not.toContain("test.todo");
      expect(testSrc).toMatch(/\btest\(/);
      expect(testSrc).toContain('from "./index"');
    });
  }
});

describe("scaffold — author workflow", () => {
  for (const type of ["tool", "skill", "agent", "multi"] as const) {
    test(`${type}: generated files use the supported host workflow`, () => {
      const { files } = scaffoldExtension({
        name: `workflow-${type}`,
        type,
        description: "author workflow check",
      });
      expect(files["ezcorp.config.ts"]).toContain("schemaVersion: 3");
      expect(files["README.md"]).toContain("EZCORP_HOST");
      expect(files["README.md"]).toContain('ext verify "$PWD"');
      expect(files["README.md"]).toContain('ext install "$PWD"');
      expect(files["README.md"]).not.toMatch(/(?:^|\n)ezcorp ext /);
      expect(files["index.test.ts"]).not.toContain("test.todo");
    });
  }

  for (const type of ["tool", "multi"] as const) {
    test(`${type}: declares an empty per-tool capability map`, () => {
      const { files } = scaffoldExtension({ name: `capabilities-${type}`, type, description: "x" });
      expect(files["ezcorp.config.ts"]).toContain("capabilities: {}");
    });
  }
});

describe("scaffold — verifyExtension passes on a fresh dir", () => {
  test("tool scaffold round-trips declared Storage through the verify host", async () => {
    const { files } = scaffoldExtension({
      name: "gate-verify-storage",
      type: "tool",
      description: "storage verification",
    });
    const manifest = files["ezcorp.config.ts"]!
      .replace("capabilities: {},", "capabilities: { storage: true },")
      .replace("permissions: {},", "permissions: { storage: true },")
      .replace('textIncludes: "Received: smoke"', 'textIncludes: "Stored: smoke"');
    const echoHandler = `export const handleRequest: ToolHandler = (args) => {
  return toolResult(\`Received: \${args.input ?? ""}\`);
};`;
    const storageHandler = `export const handleRequest: ToolHandler = async (args) => {
  const storage = new Storage("global");
  await storage.set("state", { input: args.input ?? "" });
  return toolResult(\`Stored: \${args.input ?? ""}\`);
};`;
    const entrypoint = files["index.ts"]!
      .replace("  toolResult,", "  toolResult,\n  Storage,")
      .replace(echoHandler, storageHandler);
    mkdirSync(SCAFFOLD_TMP_BASE, { recursive: true });
    const dir = mkdtempSync(join(SCAFFOLD_TMP_BASE, "storage-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), name === "ezcorp.config.ts" ? manifest : name === "index.ts" ? entrypoint : content);
      }
      const result = await verifyExtension({ extDir: dir });
      expect(result.pass).toBe(true);

      const proc = await createTestExtension(dir);
      try {
        const handler = (proc as unknown as { pendingRequestHandler: (
          req: { jsonrpc: "2.0"; id: number; method: string; params?: Record<string, unknown> },
        ) => Promise<{ result?: unknown; error?: { code: number } }> }).pendingRequestHandler;
        expect((await handler({ jsonrpc: "2.0", id: 1, method: "ezcorp/storage", params: { action: "set", key: "state", value: "saved" } })).error).toBeUndefined();
        expect(await handler({ jsonrpc: "2.0", id: 2, method: "ezcorp/storage", params: { action: "get", key: "state" } })).toMatchObject({ result: { exists: true, value: "saved" } });
        expect(await handler({ jsonrpc: "2.0", id: 3, method: "ezcorp/storage", params: { action: "list" } })).toMatchObject({ result: { keys: ["state"] } });
        expect(await handler({ jsonrpc: "2.0", id: 4, method: "ezcorp/storage", params: { action: "delete", key: "state" } })).toMatchObject({ result: { deleted: true } });
        expect((await handler({ jsonrpc: "2.0", id: 5, method: "ezcorp/storage", params: { action: "get" } })).error?.code).toBe(-32602);
        expect((await handler({ jsonrpc: "2.0", id: 6, method: "ezcorp/storage", params: { action: "other", key: "state" } })).error?.code).toBe(-32602);
        expect((await handler({ jsonrpc: "2.0", id: 7, method: "ezcorp/other" })).error?.code).toBe(-32601);
      } finally {
        proc.kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("tool scaffold written to disk ⇒ verifyExtension pass:true", async () => {
    const { files } = scaffoldExtension({
      name: "gate-verify-tool",
      type: "tool",
      description: "fresh scaffold should pass the gate",
    });
    mkdirSync(SCAFFOLD_TMP_BASE, { recursive: true });
    const dir = mkdtempSync(join(SCAFFOLD_TMP_BASE, "tool-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
      }
      const r = await verifyExtension({ extDir: dir });
      if (!r.pass) {
        throw new Error(
          `scaffold failed verify: ${JSON.stringify(r.steps, null, 2)}`,
        );
      }
      expect(r.pass).toBe(true);
      expect(r.steps.some((s) => s.name === "smoke-test-roundtrip" && s.ok)).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("multi scaffold written to disk ⇒ verifyExtension pass:true", async () => {
    const { files } = scaffoldExtension({
      name: "gate-verify-multi",
      type: "multi",
      description: "fresh multi scaffold should pass the gate",
    });
    mkdirSync(SCAFFOLD_TMP_BASE, { recursive: true });
    const dir = mkdtempSync(join(SCAFFOLD_TMP_BASE, "multi-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
      }
      const r = await verifyExtension({ extDir: dir });
      if (!r.pass) {
        throw new Error(
          `multi scaffold failed verify: ${JSON.stringify(r.steps, null, 2)}`,
        );
      }
      expect(r.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
