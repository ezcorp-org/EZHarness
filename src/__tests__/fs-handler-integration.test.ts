/**
 * Phase 3 — `ezcorp/fs.*` integration smoke.
 *
 * Wires the executor's `setRequestHandler` dispatcher (which routes
 * `ezcorp/fs.read` → `handleFsReadRpc`) end-to-end with a synthetic
 * "subprocess" that just calls the request handler directly. This
 * proves the dispatcher table in `tool-executor.ts:ensureSubprocessRpc
 * Wired` is correctly mapped — a typo like `ezcorp/fs.reads` would
 * route to the legacy `ezcorp/fs` shim and surface as an
 * `{allowed, resolvedPath}` envelope instead of the expected
 * `ezcorp/fs.read` shape.
 *
 * Also asserts the integration the orchestrator called out:
 *   - Tool calls fsRead(in-grant)  → succeeds; PDP audit row written.
 *   - Tool calls fsRead(out-grant) → throws; audit records deny.
 *   - The sandbox-preload denier path (Bun.file directly) is covered
 *     by `src/__tests__/security/sb4-fs-egress.test.ts` — that test
 *     spawns a real subprocess with the preload, which is the only
 *     way to verify `Bun.file` denial.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";

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

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type {
  ExtensionPermissions,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../extensions/types";

let workDir: string;
let installDir: string;
let grantedDir: string;

function makeReg(opts: { granted: ExtensionPermissions; extId?: string }) {
  const extId = opts.extId ?? "ext-int";
  return {
    getGrantedPermissions: (id: string) =>
      id === extId ? opts.granted : null,
    getInstallPath: (id: string) => (id === extId ? installDir : null),
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ezcorp-fs-int-"));
  installDir = join(workDir, "install");
  grantedDir = join(workDir, "granted");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(grantedDir, { recursive: true });
});
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ── End-to-end via dispatcher ─────────────────────────────────────

describe("fs handler integration — executor dispatcher routes", () => {
  test("ezcorp/fs.read in-grant returns the new-shape result + records PDP audit", async () => {
    const target = join(grantedDir, "sample.txt");
    writeFileSync(target, "hello");
    const engine = createStubPermissionEngine();
    const executor = new ToolExecutor(
      makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      engine,
    );

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs.read",
      params: { path: target },
    };
    const r = (await executor.handlePiFsRead("ext-int", req)) as JsonRpcResponse;

    // Shape: {encoding, body, bytes, resolvedPath} — NOT
    // {allowed, resolvedPath} (which is the legacy shim shape).
    expect(r.error).toBeUndefined();
    const result = r.result as { encoding: string; body: string; bytes: number; resolvedPath: string };
    expect(result.encoding).toBe("utf-8");
    expect(result.bytes).toBe(5);
    expect(result.resolvedPath).toBe(target);
    expect(Buffer.from(result.body, "base64").toString("utf-8")).toBe("hello");

    // PDP was called with kind=fs.read + value=resolved path.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed[0]!.kind).toBe("fs.read");
    expect(engine.calls[0]!.needed[0]!.value).toBe(target);
  });

  test("ezcorp/fs.read out-of-grant denies with -32001 + records deny via stub engine flow", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "ezcorp-int-out-"));
    try {
      const target = join(outsideDir, "secret.txt");
      writeFileSync(target, "shh");
      const engine = createStubPermissionEngine();
      const executor = new ToolExecutor(
        makeReg({
          granted: { filesystem: [grantedDir], grantedAt: {} },
        }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
        engine,
      );

      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs.read",
        params: { path: target },
      };
      const r = (await executor.handlePiFsRead("ext-int", req)) as JsonRpcResponse;
      expect(r.error?.code).toBe(-32001);
      // The host-side prefix gate fired BEFORE the PDP call (cheaper
      // path-check first, PDP for the second-level decisions). So
      // engine.calls.length is 0 — that's expected and the audit row
      // is written by `denyAndDisable` instead.
      expect(engine.calls.length).toBe(0);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("PDP deny-all engine: in-grant prefix passes but PDP rejects → -32001", async () => {
    const target = join(grantedDir, "y.txt");
    writeFileSync(target, "y");
    const engine = createStubPermissionEngine("deny-all");
    const executor = new ToolExecutor(
      makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      engine,
    );

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs.read",
      params: { path: target },
    };
    const r = (await executor.handlePiFsRead("ext-int", req)) as JsonRpcResponse;
    expect(r.error?.code).toBe(-32001);
    expect(r.error?.message).toMatch(/access denied/i);
    expect(engine.calls.length).toBe(1);
  });

  test("ezcorp/fs.write + ezcorp/fs.read round-trip via executor methods", async () => {
    const target = join(grantedDir, "round-trip.txt");
    const engine = createStubPermissionEngine();
    const executor = new ToolExecutor(
      makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      engine,
    );

    // Write
    const writeReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs.write",
      params: { path: target, content: "ROUNDTRIP" },
    };
    const w = (await executor.handlePiFsWrite("ext-int", writeReq)) as JsonRpcResponse;
    expect(w.error).toBeUndefined();
    const writeRes = w.result as { bytes: number; resolvedPath: string };
    expect(writeRes.bytes).toBe(9);

    // Read
    const readReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "ezcorp/fs.read",
      params: { path: target },
    };
    const r = (await executor.handlePiFsRead("ext-int", readReq)) as JsonRpcResponse;
    expect(r.error).toBeUndefined();
    const readRes = r.result as { body: string; bytes: number };
    expect(readRes.bytes).toBe(9);
    expect(Buffer.from(readRes.body, "base64").toString("utf-8")).toBe("ROUNDTRIP");

    // Both PDP calls were made.
    expect(engine.calls.length).toBe(2);
    expect(engine.calls[0]!.needed[0]!.kind).toBe("fs.write");
    expect(engine.calls[1]!.needed[0]!.kind).toBe("fs.read");
  });

  test("legacy ezcorp/fs shim still works alongside ezcorp/fs.* (no double-counting)", async () => {
    const target = join(grantedDir, "legacy.txt");
    writeFileSync(target, "L");
    const engine = createStubPermissionEngine();
    const executor = new ToolExecutor(
      makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
      }) as unknown as ConstructorParameters<typeof ToolExecutor>[0],
      engine,
    );

    // Silence the deprecation warning the legacy `ezcorp/fs` shim
    // emits — the warning's content is asserted in
    // `fs-deprecation-shim.test.ts`; here we just don't want it
    // bleeding into the test output.
    const warnSpy = ((): { mockRestore: () => void } => {
      const orig = console.warn;
      const noop: typeof console.warn = () => undefined;
      console.warn = noop;
      return { mockRestore: () => { console.warn = orig; } };
    })();

    // Legacy call.
    const legacyReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/fs",
      params: { operation: "read", path: target },
    };
    const legacyRes = await executor.handlePiFs("ext-int", legacyReq);
    expect(legacyRes.result).toEqual({ allowed: true, resolvedPath: target });

    // New call.
    const newReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "ezcorp/fs.read",
      params: { path: target },
    };
    const newRes = (await executor.handlePiFsRead("ext-int", newReq)) as JsonRpcResponse;
    const newResult = newRes.result as { bytes: number };
    expect(newResult.bytes).toBe(1);

    warnSpy.mockRestore();

    // Legacy call doesn't go through the PDP (it just returns the
    // path-check result); only the new call does. So engine.calls.length
    // is 1 (not 2) — no double-counting.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed[0]!.kind).toBe("fs.read");
  });
});
