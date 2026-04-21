// Seam 3 — Tool Execution ↔ Permission Check ↔ Disable on Violation
//
// `filesystem-mediation.test.ts` covers the permission check itself (it
// asserts `denyAndDisable` was called), but with a mocked
// `db/queries/extensions` whose `disableExtension` is a spy that never writes
// to a real table. That hides the critical chain the integration auditor
// flagged (Seam 3 in integration-auditor.md "Broken Seams"):
//
//   denied tool call → denyAndDisable() → DB row enabled=false
//     → registry.reload() re-reads DB with `enabledOnly=true`
//     → in-memory toolMap no longer has this extension's tools
//     → subsequent executeToolCall returns "Unknown tool" (NOT another
//       permission check, which would mask the disable mechanism)
//
// If any step in that chain silently breaks (disable doesn't persist, reload
// doesn't filter, etc.), production will keep executing a "disabled"
// extension's tools until restart. This test stands up a real pglite-backed
// DB and walks the full loop.
//
// Scope: runtime seam only. We do NOT spin up a real extension subprocess —
// handlePiFs is a reverse RPC handler that only needs the registry's
// grantedPerms + installPath, and the "subsequent call rejected" assertion
// relies on getRegisteredTool returning null after reload (no subprocess
// involved). Filesystem-mediation.test.ts is a unit test for the permission
// check; this test is the cross-module integration.

import { test, expect, describe, beforeEach, afterAll, beforeAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  getTestDb,
  mockDbConnection,
  mockRealSettings,
} from "./helpers/test-pglite";

// ── Module-level mocks (must run BEFORE importing anything that touches DB) ──

mockDbConnection();
mockRealSettings();

// Stub the subprocess module — ExtensionRegistry.loadFromDb doesn't spawn
// processes (that only happens on getProcess()), but registry.ts imports
// ExtensionProcess at module load. We don't call getProcess() in this seam
// test so a no-op stub is sufficient.
mock.module("../extensions/subprocess", () => ({
  ExtensionProcess: class {
    isRunning = false;
    kill() {}
  },
  parseMemoryLimit: (_: string) => undefined,
}));

import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { getSecurityViolations } from "../extensions/security";
// NOTE: intentionally NOT importing hasSecurityViolation — see test comment
// in the "allowed fs call" case.
import { extensions, toolCalls, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionManifestV2 } from "../extensions/types";
import type { JsonRpcRequest } from "../extensions/types";

// ── Fixtures ─────────────────────────────────────────────────────────

const EXT_NAME = "seam3-fs-ext";
const EXT_VERSION = "1.0.0";
const TOOL_NAME = "read_file";
const NAMESPACED_TOOL = `${EXT_NAME}__${TOOL_NAME}`;

let testDir: string;
let installDir: string;
let allowedDir: string;
let outsideDir: string;
let extensionId: string;

function buildManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: EXT_VERSION,
    description: "Seam 3 integration fixture",
    author: { name: "seam3" },
    entrypoint: "./index.js",
    tools: [
      {
        name: TOOL_NAME,
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    permissions: { filesystem: [] }, // populated per-test via setGrantedPermsForTest
  };
}

function makeFsRequest(operation: string, path: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method: "ezcorp/fs", params: { operation, path } };
}

// ── Setup / teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  restoreModuleMocks();
  await closeTestDb();
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe state that accumulates across tests.
  ExtensionRegistry.resetInstance();
  const db = getTestDb();
  await db.delete(toolCalls);
  await db.delete(extensions);
  await db.delete(settings);

  // Fresh filesystem fixtures — unique per test so violations don't collide.
  testDir = join(tmpdir(), `seam3-${randomUUID()}`);
  installDir = join(testDir, "install");
  allowedDir = join(testDir, "allowed");
  outsideDir = join(testDir, "outside");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(allowedDir, "ok.txt"), "ok");
  writeFileSync(join(outsideDir, "secret.txt"), "secret");

  // Insert a real extension row so loadFromDb populates the registry from DB.
  const rows = await db
    .insert(extensions)
    .values({
      name: EXT_NAME,
      version: EXT_VERSION,
      description: "Seam 3 integration fixture",
      manifest: buildManifest(),
      source: `local:${installDir}`,
      installPath: installDir,
      enabled: true,
      grantedPermissions: { filesystem: [allowedDir], grantedAt: {} } as any,
    })
    .returning({ id: extensions.id });
  extensionId = rows[0]!.id;
});

// ── Tests ────────────────────────────────────────────────────────────

describe("Seam 3: permission violation → DB disable → next call rejected", () => {
  test("violating fs call disables the extension in the real DB and records the violation", async () => {
    const db = getTestDb();
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    // Sanity: the tool is registered after loadFromDb.
    const before = registry.getRegisteredTool(NAMESPACED_TOOL);
    expect(before).not.toBeNull();
    expect(before!.extensionId).toBe(extensionId);

    // Sanity: DB says enabled=true before the violation.
    const preRow = await db.select().from(extensions).where(eq(extensions.id, extensionId));
    expect(preRow[0]!.enabled).toBe(true);

    // Trigger the violation via the real ToolExecutor + real registry path.
    const executor = new ToolExecutor(registry);
    const res = await executor.handlePiFs(
      extensionId,
      makeFsRequest("read", join(outsideDir, "secret.txt")),
    );

    // The seam's immediate response: structured deny with "disabled" message.
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32001);
    expect(res.error!.message).toContain("Filesystem access denied");
    expect(res.error!.message).toContain("disabled");

    // The DB row is actually flipped — no mocks hiding this.
    const postRow = await db.select().from(extensions).where(eq(extensions.id, extensionId));
    expect(postRow[0]!.enabled).toBe(false);

    // The violation is recorded in settings (backed by mockRealSettings →
    // the same pglite DB).
    const violations = await getSecurityViolations(extensionId);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.extensionId).toBe(extensionId);
    expect(violations[0]!.reason).toContain("Filesystem access denied");
    expect(violations[0]!.reason).toContain("read");
  });

  test("registry.reload() unloads the disabled extension and its tools", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).not.toBeNull();

    // Violate → disable (this is what the fs RPC handler does in prod).
    const executor = new ToolExecutor(registry);
    await executor.handlePiFs(extensionId, makeFsRequest("read", join(outsideDir, "secret.txt")));

    // Reload simulates the next startup / the admin endpoint that reloads
    // after a violation. loadFromDb uses listExtensions(true) which filters
    // by enabled=true, so the disabled extension should disappear.
    await registry.reload();

    expect(registry.getRegisteredTool(NAMESPACED_TOOL)).toBeNull();
    expect(registry.getGrantedPermissions(extensionId)).toBeNull();
    expect(registry.getInstallPath(extensionId)).toBeNull();
    expect(registry.getToolsForExtension(extensionId)).toHaveLength(0);
  });

  test("subsequent executeToolCall on a disabled extension rejects with 'Unknown tool'", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry);

    // Violate → disable → reload the registry from the (now-updated) DB.
    await executor.handlePiFs(extensionId, makeFsRequest("read", join(outsideDir, "secret.txt")));
    await registry.reload();

    // Now the seam's terminal assertion: invoking the previously-registered
    // tool name must not sneak through. It should hit the "tool not found"
    // branch of executeToolCall, NOT a permission checker (because that
    // would mask the disable mechanism — a broken permission checker would
    // let the call through). "Unknown tool" is the only acceptable answer.
    const result = await executor.executeToolCall(
      NAMESPACED_TOOL,
      { path: join(allowedDir, "ok.txt") },
      "conv-seam3",
      "msg-seam3",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
    expect(result.content[0]!.text).toContain(NAMESPACED_TOOL);
  });

  test("a second violation on the same disabled extension accumulates in violation history", async () => {
    // This guards a subtle regression: if denyAndDisable short-circuited on
    // an already-disabled extension, the second violation would be lost and
    // the admin UI would under-report abuse. The contract is additive — each
    // attempt is recorded, regardless of current enabled state.
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry);

    await executor.handlePiFs(extensionId, makeFsRequest("read", join(outsideDir, "secret.txt")));
    await executor.handlePiFs(
      extensionId,
      makeFsRequest("write", join(outsideDir, "secret.txt")),
    );

    const violations = await getSecurityViolations(extensionId);
    expect(violations).toHaveLength(2);
    expect(violations[0]!.reason).toContain("read");
    expect(violations[1]!.reason).toContain("write");

    // Still disabled (idempotent-at-bottom — never reverts to enabled).
    const db = getTestDb();
    const row = await db.select().from(extensions).where(eq(extensions.id, extensionId));
    expect(row[0]!.enabled).toBe(false);
  });

  test("an allowed fs call on the same extension does NOT trip the disable path", async () => {
    // Control case: a legitimate call must not be mistaken for a violation.
    // Guards against a regression where checkFilesystemPermission over-denies
    // and the seam accidentally disables well-behaved extensions.
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry);

    const res = await executor.handlePiFs(
      extensionId,
      makeFsRequest("read", join(allowedDir, "ok.txt")),
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    expect((res.result as any).allowed).toBe(true);

    const db = getTestDb();
    const row = await db.select().from(extensions).where(eq(extensions.id, extensionId));
    expect(row[0]!.enabled).toBe(true); // untouched
    // NB: we use getSecurityViolations (which `?? []`s) instead of
    // hasSecurityViolation — the latter crashes on `undefined` from
    // getSetting on a never-recorded key (see SendMessage to team-lead
    // for the source bug report). getSecurityViolations is safe.
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);
  });
});
