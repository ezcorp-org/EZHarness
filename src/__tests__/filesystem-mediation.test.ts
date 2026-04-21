import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionPermissions, JsonRpcRequest } from "../extensions/types";

// ── Mocks ────────────────────────────────────────────────────────

let disableExtensionCalls: string[] = [];

mock.module("../db/queries/extensions", () => ({
  disableExtension: async (id: string) => {
    disableExtensionCalls.push(id);
  },
  listExtensions: async () => [],
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));

// Mock DB connection (tool-executor imports it for recordToolCall, security.ts for getSetting)
mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => {} }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }),
}));

mock.module("../db/schema", () => require("../db/schema"));

afterAll(() => restoreModuleMocks());

// ── Imports (after mocks) ────────────────────────────────────────

import { ToolExecutor } from "../extensions/tool-executor";
import { ExtensionRegistry } from "../extensions/registry";
import { denyAndDisable } from "../extensions/security";

// ── Fixtures ─────────────────────────────────────────────────────

let testDir: string;
let installDir: string;
let allowedDir: string;
let outsideDir: string;
let registry: ExtensionRegistry;
let executor: ToolExecutor;

const EXT_ID = "test-fs-ext";

function makeRequest(operation: string, path: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/fs",
    params: { operation, path },
  };
}

beforeEach(() => {
  disableExtensionCalls = [];
  testDir = join(tmpdir(), `pi-fs-mediation-${randomUUID()}`);
  installDir = join(testDir, "ext-install");
  allowedDir = join(testDir, "allowed");
  outsideDir = join(testDir, "outside");

  mkdirSync(join(installDir, "data"), { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(allowedDir, "ok.txt"), "ok");
  writeFileSync(join(outsideDir, "secret.txt"), "secret");
  writeFileSync(join(installDir, "data", "local.txt"), "local");

  // Set up registry with test data
  ExtensionRegistry.resetInstance();
  registry = ExtensionRegistry.getInstance();
  registry.setGrantedPermsForTest(EXT_ID, {
    filesystem: [allowedDir],
    grantedAt: {},
  });
  registry.setInstallPathForTest(EXT_ID, installDir);

  executor = new ToolExecutor(registry);
});

afterEach(() => {
  ExtensionRegistry.resetInstance();
  rmSync(testDir, { recursive: true, force: true });
});

// ── ezcorp/fs handler tests ──────────────────────────────────────────

describe("ezcorp/fs filesystem mediation", () => {
  test("read request within declared permissions returns allowed", async () => {
    const req = makeRequest("read", join(allowedDir, "ok.txt"));
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      allowed: true,
      resolvedPath: join(allowedDir, "ok.txt"),
    });
  });

  test("read request outside declared permissions returns error and calls denyAndDisable", async () => {
    const req = makeRequest("read", join(outsideDir, "secret.txt"));
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32001);
    expect(res.error!.message).toContain("Filesystem access denied");
    expect(res.error!.message).toContain("disabled");
    expect(disableExtensionCalls).toContain(EXT_ID);
  });

  test("write request within declared permissions returns allowed", async () => {
    const req = makeRequest("write", join(allowedDir, "ok.txt"));
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      allowed: true,
      resolvedPath: join(allowedDir, "ok.txt"),
    });
  });

  test("write request outside declared permissions calls denyAndDisable", async () => {
    const req = makeRequest("write", join(outsideDir, "secret.txt"));
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32001);
    expect(disableExtensionCalls).toContain(EXT_ID);
  });

  test("path traversal (../) is blocked after realpath resolution", async () => {
    const traversalPath = join(allowedDir, "..", "outside", "secret.txt");
    const req = makeRequest("read", traversalPath);
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32001);
    expect(disableExtensionCalls).toContain(EXT_ID);
  });

  test("access to extension's own install directory is implicitly allowed", async () => {
    const req = makeRequest("read", join(installDir, "data", "local.txt"));
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      allowed: true,
      resolvedPath: join(installDir, "data", "local.txt"),
    });
  });

  test("returns structured error with violation details on denial", async () => {
    const req = makeRequest("read", join(outsideDir, "secret.txt"));
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32001);
    expect(res.error!.message).toContain(join(outsideDir, "secret.txt"));
  });

  test("missing path parameter returns -32602 error", async () => {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "ezcorp/fs",
      params: { operation: "read" },
    };
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
    expect(res.error!.message).toContain("Missing path or operation");
  });

  test("missing operation parameter returns -32602 error", async () => {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "ezcorp/fs",
      params: { path: "/some/path" },
    };
    const res = await executor.handlePiFs(EXT_ID, req);

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32602);
  });

  test("unknown extension returns -32603 error", async () => {
    const req = makeRequest("read", "/any/path");
    const res = await executor.handlePiFs("nonexistent-ext", req);

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32603);
    expect(res.error!.message).toContain("Extension not found");
  });
});
