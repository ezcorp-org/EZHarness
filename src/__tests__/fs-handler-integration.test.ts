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
  afterAll,
  mock,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Restore in afterAll so the DB mocks below don't leak into subsequent
// test files.
afterAll(() => restoreModuleMocks());

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
import {
  registerCallProvenance,
  _resetCallProvenanceForTests,
} from "../extensions/call-provenance";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import {
  handleFsReadRpc,
  handleFsWriteRpc,
} from "../extensions/fs-handler";
import type {
  ExtensionPermissions,
  ExtensionManifestV2,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../extensions/types";

let workDir: string;
let installDir: string;
let grantedDir: string;

function makeReg(opts: {
  granted: ExtensionPermissions;
  extId?: string;
  manifest?: ExtensionManifestV2;
}) {
  const extId = opts.extId ?? "ext-int";
  return {
    getGrantedPermissions: (id: string) =>
      id === extId ? opts.granted : null,
    getInstallPath: (id: string) => (id === extId ? installDir : null),
    getManifest: (id: string) => (id === extId ? opts.manifest : undefined),
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

/**
 * Mint a real host-issued reverse-RPC provenance token for `ext-int`
 * and return the `_meta` block the "subprocess" echoes back. The
 * executor's `handlePiFs*` methods resolve the caller's identity from
 * this token (NOT process-wide singletons) and fail fast with -32602 if
 * it's absent — see `tool-executor.ts:resolveReverseRpcMeta`. The token
 * `actorExtensionId` MUST equal the resolving extension id to avoid the
 * tripwire warning. Provenance only feeds the PDP/audit; the path
 * allowlist is keyed on the extension grant, so this never weakens the
 * out-of-grant deny assertions.
 */
function extIntMeta(): { ezCallId: string } {
  const ezCallId = registerCallProvenance({
    onBehalfOf: "u",
    conversationId: "conv",
    runId: "run-int",
    parentCallId: null,
    actorExtensionId: "ext-int",
    kind: "tool",
    ownerless: false,
  });
  return { ezCallId };
}

beforeEach(() => {
  _resetCallProvenanceForTests();
  workDir = mkdtempSync(join(tmpdir(), "ezcorp-fs-int-"));
  installDir = join(workDir, "install");
  grantedDir = join(workDir, "granted");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(grantedDir, { recursive: true });
});
afterEach(() => {
  _resetCallProvenanceForTests();
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
      params: { path: target, _meta: extIntMeta() },
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
        params: { path: target, _meta: extIntMeta() },
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
      params: { path: target, _meta: extIntMeta() },
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
      params: { path: target, content: "ROUNDTRIP", _meta: extIntMeta() },
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
      params: { path: target, _meta: extIntMeta() },
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
      params: { path: target, _meta: extIntMeta() },
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

// ════════════════════════════════════════════════════════════════════
// M5 — per-tool mode narrowing via manifest `capabilities.filesystem.mode`
// ════════════════════════════════════════════════════════════════════
//
// Validator should-fix #2: prove the end-to-end mode narrowing path
// works. The SDK helpers (fsRead/fsWrite/...) forward the active tool
// name as `_toolName` from `getToolContext()`. The host's fs-handler
// looks up the manifest tool and rejects when the requested mode
// (read/write) isn't declared.
//
// Pre-Phase-3-edit: `_toolName` was never sent or read; the registry-
// derived granted set always emitted both `fs.read` AND `fs.write` for
// any granted path, so per-tool mode narrowing was effectively a no-op.
// Post-fix, the host's `checkToolMode` short-circuits before the PDP
// call when the manifest tool's mode array excludes the requested op.

describe("fs handler integration — per-tool mode narrowing (M5)", () => {
  function makeManifestWithReadOnlyTool(): ExtensionManifestV2 {
    return {
      schemaVersion: 3,
      name: "test-ext-mode",
      version: "1.0.0",
      description: "fixture",
      author: { name: "T" },
      entrypoint: "./index.ts",
      tools: [
        {
          name: "t1",
          description: "read-only tool",
          inputSchema: { type: "object" },
          // Per-tool capability: read-only filesystem.
          capabilities: {
            filesystem: { paths: [], mode: ["read"] },
          },
        },
        {
          name: "t2",
          description: "read+write tool",
          inputSchema: { type: "object" },
          capabilities: {
            filesystem: { paths: [], mode: ["read", "write"] },
          },
        },
      ],
      permissions: {
        filesystem: [], // populated at runtime via opts.granted
      },
    };
  }

  test("fsWrite via tool t1 (mode: ['read']) is denied with mode-mismatch reason", async () => {
    const target = join(grantedDir, "out.txt");
    const manifest = makeManifestWithReadOnlyTool();
    const ctx = {
      extensionId: "ext-int",
      conversationId: "conv",
      userId: "u",
      engine: createStubPermissionEngine(),
      registry: makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
        manifest,
      }) as unknown as Parameters<typeof handleFsWriteRpc>[1]["registry"],
    };

    const r = (await handleFsWriteRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs.write",
        params: { path: target, content: "x", _toolName: "t1" },
      },
      ctx,
    )) as JsonRpcResponse;

    expect(r.error?.code).toBe(-32001);
    expect(r.error?.message).toMatch(/mode/i);
    expect(r.error?.message).toMatch(/t1/);
    expect(r.error?.message).toMatch(/write/);
  });

  test("fsRead via tool t1 (mode: ['read']) succeeds — read is in the declared mode list", async () => {
    const target = join(grantedDir, "in.txt");
    writeFileSync(target, "ok");
    const manifest = makeManifestWithReadOnlyTool();
    const ctx = {
      extensionId: "ext-int",
      conversationId: "conv",
      userId: "u",
      engine: createStubPermissionEngine(),
      registry: makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
        manifest,
      }) as unknown as Parameters<typeof handleFsReadRpc>[1]["registry"],
    };

    const r = (await handleFsReadRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs.read",
        params: { path: target, _toolName: "t1" },
      },
      ctx,
    )) as JsonRpcResponse;

    expect(r.error).toBeUndefined();
    const result = r.result as { bytes: number };
    expect(result.bytes).toBe(2);
  });

  test("fsWrite via tool t2 (mode: ['read', 'write']) succeeds", async () => {
    const target = join(grantedDir, "via-t2.txt");
    const manifest = makeManifestWithReadOnlyTool();
    const ctx = {
      extensionId: "ext-int",
      conversationId: "conv",
      userId: "u",
      engine: createStubPermissionEngine(),
      registry: makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
        manifest,
      }) as unknown as Parameters<typeof handleFsWriteRpc>[1]["registry"],
    };

    const r = (await handleFsWriteRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs.write",
        params: { path: target, content: "ok", _toolName: "t2" },
      },
      ctx,
    )) as JsonRpcResponse;

    expect(r.error).toBeUndefined();
  });

  test("fsWrite without _toolName: no narrowing (legacy / non-SDK callers)", async () => {
    // Defensive fallback: extensions that bypass the SDK helper and
    // send raw JSON-RPC frames don't include `_toolName`. The handler
    // treats absence as "no per-tool narrowing" — extension-wide
    // grant applies. This preserves back-compat for the deprecation
    // window.
    const target = join(grantedDir, "no-tool.txt");
    const manifest = makeManifestWithReadOnlyTool();
    const ctx = {
      extensionId: "ext-int",
      conversationId: "conv",
      userId: "u",
      engine: createStubPermissionEngine(),
      registry: makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
        manifest,
      }) as unknown as Parameters<typeof handleFsWriteRpc>[1]["registry"],
    };

    const r = (await handleFsWriteRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs.write",
        params: { path: target, content: "x" },
      },
      ctx,
    )) as JsonRpcResponse;

    expect(r.error).toBeUndefined();
  });

  test("fsWrite via tool with no manifest entry: no narrowing (defensive)", async () => {
    const target = join(grantedDir, "unknown-tool.txt");
    const manifest = makeManifestWithReadOnlyTool();
    const ctx = {
      extensionId: "ext-int",
      conversationId: "conv",
      userId: "u",
      engine: createStubPermissionEngine(),
      registry: makeReg({
        granted: { filesystem: [grantedDir], grantedAt: {} },
        manifest,
      }) as unknown as Parameters<typeof handleFsWriteRpc>[1]["registry"],
    };

    const r = (await handleFsWriteRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs.write",
        params: { path: target, content: "x", _toolName: "not-in-manifest" },
      },
      ctx,
    )) as JsonRpcResponse;

    expect(r.error).toBeUndefined();
  });
});
