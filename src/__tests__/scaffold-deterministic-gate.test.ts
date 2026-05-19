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

describe("scaffold — verifyExtension passes on a fresh dir", () => {
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
