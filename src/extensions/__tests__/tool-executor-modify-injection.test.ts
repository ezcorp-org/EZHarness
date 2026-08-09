// Unit test for the `modify_extension` sensitive-capability injection
// in `ToolExecutor.executeToolCall` (src/extensions/tool-executor.ts).
//
// The injection mirrors the proven `install_draft` block: only when
// the tool is `modify_extension` AND the manifest is `extension-author`
// AND the registry reports it bundled does `{kind:
// "ezcorp:extension:modify"}` enter the PDP `needed` set. We drive a
// real ToolExecutor with a mock registry + a mock PermissionEngine
// whose `authorize` CAPTURES `needed` then returns `deny` (short-
// circuits before any subprocess), and assert the injection predicate
// on all four arms + the install_draft parity arm.

import { test, expect, describe, mock, afterAll } from "bun:test";
import { setupTestDb, getTestPglite, closeTestDb } from "../../__tests__/helpers/test-pglite";

// ToolExecutor's import graph can transitively touch db/connection;
// stub it like drafts-handler.test.ts so import never needs a live DB.
mock.module("../../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

await setupTestDb();
// Release the PGlite handle at teardown, like the other 396 DB-using suites.
// PGlite 0.5.x aborts the process (exit 99) when a WASM instance is still open
// at exit, so leaking it turns an all-green file into a failed one.
afterAll(async () => {
  await closeTestDb();
});
const { ToolExecutor } = await import("../tool-executor");

interface Cap {
  kind: string;
  value?: string;
}

function makeExecutor(opts: {
  toolName: string;
  manifestName: string;
  bundled: boolean;
}): { run: () => Promise<unknown>; captured: () => Cap[] } {
  let captured: Cap[] = [];
  const registry = {
    getRegisteredTool: (toolName: string) => ({
      extensionId: "ext-id",
      originalName: toolName,
    }),
    getManifest: (_extId: string) => ({
      name: opts.manifestName,
      tools: [
        { name: "modify_extension", capabilities: {} },
        { name: "install_draft", capabilities: {} },
        { name: "other_tool", capabilities: {} },
      ],
    }),
    isBundled: (_extId: string) => opts.bundled,
  } as never;
  const engine = {
    authorize: async (_ctx: unknown, needed: Cap[]) => {
      captured = needed;
      return { decision: "deny", reason: "test-capture" };
    },
  } as never;
  const executor = new ToolExecutor(registry, engine);
  return {
    run: () =>
      executor.executeToolCall(
        opts.toolName,
        { name: "x" },
        `conv-${Math.random().toString(36).slice(2)}`,
        null,
      ),
    captured: () => captured,
  };
}

async function neededFor(opts: {
  toolName: string;
  manifestName: string;
  bundled: boolean;
}): Promise<Cap[]> {
  const { run, captured } = makeExecutor(opts);
  // Deny → executeToolCall rejects with PermissionDeniedError; the
  // engine already captured `needed` before the throw.
  await run().then(
    () => {
      throw new Error("expected a permission denial");
    },
    () => {},
  );
  return captured();
}

const hasModify = (c: Cap[]) =>
  c.some((x) => x.kind === "ezcorp:extension:modify");
const hasInstall = (c: Cap[]) =>
  c.some((x) => x.kind === "ezcorp:extension:install");

describe("ToolExecutor — ezcorp:extension:modify injection", () => {
  test("injected for modify_extension on the bundled extension-author", async () => {
    expect(
      hasModify(
        await neededFor({
          toolName: "modify_extension",
          manifestName: "extension-author",
          bundled: true,
        }),
      ),
    ).toBe(true);
  });

  test("NOT injected when the extension is not bundled (look-alike)", async () => {
    expect(
      hasModify(
        await neededFor({
          toolName: "modify_extension",
          manifestName: "extension-author",
          bundled: false,
        }),
      ),
    ).toBe(false);
  });

  test("NOT injected when the manifest name is not extension-author", async () => {
    expect(
      hasModify(
        await neededFor({
          toolName: "modify_extension",
          manifestName: "evil-author",
          bundled: true,
        }),
      ),
    ).toBe(false);
  });

  test("NOT injected for a different tool on bundled extension-author", async () => {
    expect(
      hasModify(
        await neededFor({
          toolName: "other_tool",
          manifestName: "extension-author",
          bundled: true,
        }),
      ),
    ).toBe(false);
  });

  test("parity: install_draft still injects the install cap (adjacent block intact)", async () => {
    const needed = await neededFor({
      toolName: "install_draft",
      manifestName: "extension-author",
      bundled: true,
    });
    expect(hasInstall(needed)).toBe(true);
    expect(hasModify(needed)).toBe(false);
  });
});
