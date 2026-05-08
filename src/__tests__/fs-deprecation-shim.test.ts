/**
 * Phase 3 — `ezcorp/fs` (path-check) deprecation shim test.
 *
 * The legacy `ezcorp/fs` reverse-RPC stays for one release after
 * Phase 3 ships so existing extensions (and the SDK helpers in old
 * versions of @ezcorp/sdk) keep working unchanged. The shim:
 *
 *   1. Returns `{allowed, resolvedPath}` IDENTICAL to the
 *      pre-Phase-3 shape for in-grant paths.
 *   2. Returns -32001 for out-of-grant paths and trips
 *      `denyAndDisable` (same as pre-Phase-3).
 *   3. Emits a one-time `console.warn` per extension on FIRST call.
 *      The warning names the extension and points to the new
 *      operation-specific helpers.
 *   4. Subsequent calls from the SAME extension are silent — no
 *      log spam.
 *   5. Different extensions get their own warning (Set-keyed by
 *      extension id).
 *   6. Calling the new operation-specific handlers alongside the
 *      shim does NOT cause double-counting (each path checks the
 *      PDP once).
 */

import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";

// DB mocks so denyAndDisable / audit-log writes don't trip
// "Database not initialized" in test mode (mirrors fs-handler.test.ts).
mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => {} }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));
mock.module("../db/queries/extensions", () => ({
  disableExtension: async () => {},
  incrementFailures: async () => 0,
  resetFailures: async () => {},
  listExtensions: async () => [],
}));
mock.module("../db/queries/settings", () => ({
  getSetting: async () => null,
  upsertSetting: async () => {},
}));
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
}));

import {
  ToolExecutor,
  _resetFsDeprecationWarningsForTests,
} from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type {
  ExtensionPermissions,
  JsonRpcRequest,
} from "../extensions/types";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test rig ──────────────────────────────────────────────────────

let workDir: string;
let installDir: string;
let grantedDir: string;

function makeMockRegistry(opts: {
  granted?: ExtensionPermissions;
  installPath?: string;
  extId?: string;
}) {
  const granted: ExtensionPermissions = opts.granted ?? { grantedAt: {} };
  const installPath = opts.installPath ?? installDir;
  const extId = opts.extId ?? "ext-1";
  return {
    getGrantedPermissions: (id: string) => (id === extId ? granted : null),
    getInstallPath: (id: string) => (id === extId ? installPath : null),
    getManifest: () => undefined,
    getRegisteredTool: () => null,
    getProcess: async () => ({}),
    getAllTools: () => [],
    getToolExtension: () => null,
    resolveDepTool: () => null,
    loadFromDb: async () => {},
    reload: async () => {},
    killAll: () => {},
  };
}

function makeRequest(
  method: string,
  params: Record<string, unknown>,
  id = 1,
): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ezcorp-fs-deprec-"));
  installDir = join(workDir, "install");
  grantedDir = join(workDir, "granted");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(grantedDir, { recursive: true });
  _resetFsDeprecationWarningsForTests();
});

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  _resetFsDeprecationWarningsForTests();
});

// ── Behavioral parity with pre-Phase-3 ─────────────────────────────

describe("ezcorp/fs deprecation shim — pre-Phase-3 shape parity", () => {
  test("in-grant path returns {allowed: true, resolvedPath} identical to old shape", async () => {
    const target = join(grantedDir, "x.txt");
    writeFileSync(target, "data");

    const executor = new ToolExecutor(
      makeMockRegistry({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      createStubPermissionEngine(),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const r = await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }),
    );

    warnSpy.mockRestore();

    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ allowed: true, resolvedPath: target });
  });

  test("out-of-grant path returns -32001 + Filesystem access denied message", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "ezcorp-deprec-out-"));
    try {
      const target = join(outsideDir, "secret.txt");
      writeFileSync(target, "shh");
      const executor = new ToolExecutor(
        makeMockRegistry({
          granted: { filesystem: [grantedDir], grantedAt: {} },
        }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
        createStubPermissionEngine(),
      );

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const r = await executor.handlePiFs(
        "ext-1",
        makeRequest("ezcorp/fs", { operation: "read", path: target }),
      );
      warnSpy.mockRestore();

      expect(r.error?.code).toBe(-32001);
      expect(r.error?.message).toMatch(/Filesystem access denied/);
      expect(r.error?.message).toMatch(/disabled/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("missing operation/path → -32602 (back-compat)", async () => {
    const executor = new ToolExecutor(
      makeMockRegistry({}) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      createStubPermissionEngine(),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const r = await executor.handlePiFs("ext-1", {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs",
      // no params
    });
    warnSpy.mockRestore();

    expect(r.error?.code).toBe(-32602);
  });
});

// ── Deprecation warning emission ──────────────────────────────────

describe("ezcorp/fs deprecation shim — one-time console.warn per extension", () => {
  test("first call from ext-A emits a warning naming the extension + new helpers", async () => {
    const target = join(grantedDir, "x.txt");
    writeFileSync(target, "data");
    const executor = new ToolExecutor(
      makeMockRegistry({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      createStubPermissionEngine(),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }),
    );
    const callsLen = warnSpy.mock.calls.length;
    const firstCallArg = warnSpy.mock.calls[0]?.[0];
    warnSpy.mockRestore();

    expect(callsLen).toBe(1);
    const msg = String(firstCallArg ?? "");
    expect(msg).toContain("ext-1");
    expect(msg).toContain("deprecated");
    expect(msg).toContain("ezcorp/fs.read");
    expect(msg).toContain("write");
    expect(msg).toContain("list");
    expect(msg).toContain("stat");
    expect(msg).toContain("exists");
    expect(msg).toContain("mkdir");
    expect(msg).toContain("unlink");
  });

  test("subsequent calls from same extension do NOT re-emit the warning", async () => {
    const target = join(grantedDir, "x.txt");
    writeFileSync(target, "data");
    const executor = new ToolExecutor(
      makeMockRegistry({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      createStubPermissionEngine(),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 1),
    );
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 2),
    );
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 3),
    );
    const callsLen = warnSpy.mock.calls.length;
    warnSpy.mockRestore();

    expect(callsLen).toBe(1);
  });

  test("different extensions each get their own warning (Set-keyed by extension id)", async () => {
    const target = join(grantedDir, "x.txt");
    writeFileSync(target, "data");
    const ext1Reg = makeMockRegistry({
      granted: { filesystem: [grantedDir], grantedAt: {} },
      extId: "ext-1",
    });
    // Build a registry that returns granted for BOTH ids.
    const dualReg = {
      ...ext1Reg,
      getGrantedPermissions: (id: string) => {
        if (id === "ext-1" || id === "ext-2") {
          return { filesystem: [grantedDir], grantedAt: {} };
        }
        return null;
      },
      getInstallPath: (id: string) =>
        id === "ext-1" || id === "ext-2" ? installDir : null,
    };
    const executor = new ToolExecutor(
      dualReg as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      createStubPermissionEngine(),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 1),
    );
    await executor.handlePiFs(
      "ext-2",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 2),
    );
    // Re-call ext-1 to confirm it stays at one warn.
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 3),
    );
    const callsLen = warnSpy.mock.calls.length;
    const callArgs = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
    warnSpy.mockRestore();

    expect(callsLen).toBe(2);
    expect(callArgs[0]).toContain("ext-1");
    expect(callArgs[1]).toContain("ext-2");
  });

  test("denied path STILL emits the deprecation warning (gate runs at top)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "ezcorp-deprec-out-"));
    try {
      const target = join(outsideDir, "secret.txt");
      writeFileSync(target, "shh");
      const executor = new ToolExecutor(
        makeMockRegistry({
          granted: { filesystem: [grantedDir], grantedAt: {} },
        }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
        createStubPermissionEngine(),
      );

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const r = await executor.handlePiFs(
        "ext-1",
        makeRequest("ezcorp/fs", { operation: "read", path: target }),
      );
      const callsLen = warnSpy.mock.calls.length;
      warnSpy.mockRestore();

      expect(r.error?.code).toBe(-32001);
      expect(callsLen).toBe(1);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("_resetFsDeprecationWarningsForTests clears the tracker", async () => {
    const target = join(grantedDir, "x.txt");
    writeFileSync(target, "data");
    const executor = new ToolExecutor(
      makeMockRegistry({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      createStubPermissionEngine(),
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 1),
    );
    const callsAfterFirst = warnSpy.mock.calls.length;

    _resetFsDeprecationWarningsForTests();
    await executor.handlePiFs(
      "ext-1",
      makeRequest("ezcorp/fs", { operation: "read", path: target }, 2),
    );
    const callsAfterReset = warnSpy.mock.calls.length;
    warnSpy.mockRestore();

    expect(callsAfterFirst).toBe(1);
    expect(callsAfterReset).toBe(2);
  });
});
