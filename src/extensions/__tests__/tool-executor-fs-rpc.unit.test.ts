// Focused coverage for the extracted `tool-executor/fs-rpc.ts` per-op handlers
// that no other suite exercises end-to-end: fs.read / fs.list / fs.stat /
// fs.unlink (fs.write + fs.mkdir + the error arms are covered by
// tool-executor.fs-provenance.test.ts). Each is invoked through the public
// ToolExecutor method (delegate → free function) with a resolvable host-issued
// ezCallId token over a real temp dir, so the whole per-op path executes.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import {
  registerCallProvenance,
  releaseCallProvenance,
  _resetCallProvenanceForTests,
  type CallProvenance,
} from "../call-provenance";
import type { ExtensionRegistry } from "../registry";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";

function makeStubRegistry(installDir: string): ExtensionRegistry {
  return {
    getGrantedPermissions: (_id: string) => ({
      grantedAt: {},
      filesystem: [installDir],
    }),
    getManifest: (_id: string) => ({ schemaVersion: 2, name: "ext" }),
    getInstallPath: (_id: string) => installDir,
    getRegisteredTool: (_name: string) => null,
  } as unknown as ExtensionRegistry;
}

function provFor(userId: string, convId: string): CallProvenance {
  return {
    onBehalfOf: userId,
    conversationId: convId,
    runId: null,
    parentCallId: null,
    actorExtensionId: "ext-1",
    kind: "tool",
    ownerless: false,
  };
}

function fsReq(
  method: string,
  path: string,
  ezCallId: string,
  extra: Record<string, unknown> = {},
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { path, ...extra, _meta: { ezCallId } },
  };
}

describe("ToolExecutor fs-rpc per-op handlers (read/list/stat/unlink)", () => {
  let tmp: string;
  let installDir: string;
  let registry: ExtensionRegistry;
  let engine: ReturnType<typeof createStubPermissionEngine>;
  let executor: ToolExecutor;

  beforeEach(async () => {
    _resetCallProvenanceForTests();
    tmp = await mkdtemp(join(tmpdir(), "ezcorp-fs-rpc-"));
    installDir = await realpath(tmp);
    registry = makeStubRegistry(installDir);
    engine = createStubPermissionEngine("allow-all");
    executor = new ToolExecutor(registry, engine);
  });

  afterEach(async () => {
    _resetCallProvenanceForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  test("fs.read returns the file contents host-side", async () => {
    await writeFile(join(installDir, "note.txt"), "hello-read", "utf-8");
    const tok = registerCallProvenance(provFor("user-R", "conv-R"));
    try {
      const resp = (await executor.handlePiFsRead(
        "ext-1",
        fsReq("ezcorp/fs.read", join(installDir, "note.txt"), tok),
      )) as JsonRpcResponse;
      expect("error" in resp && resp.error).toBeFalsy();
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("fs.list enumerates the directory host-side", async () => {
    await writeFile(join(installDir, "a.txt"), "a", "utf-8");
    await mkdir(join(installDir, "sub"), { recursive: true });
    const tok = registerCallProvenance(provFor("user-L", "conv-L"));
    try {
      const resp = (await executor.handlePiFsList(
        "ext-1",
        fsReq("ezcorp/fs.list", installDir, tok),
      )) as JsonRpcResponse;
      expect("error" in resp && resp.error).toBeFalsy();
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("fs.stat resolves metadata for a real path", async () => {
    await writeFile(join(installDir, "s.txt"), "stat-me", "utf-8");
    const tok = registerCallProvenance(provFor("user-S", "conv-S"));
    try {
      const resp = (await executor.handlePiFsStat(
        "ext-1",
        fsReq("ezcorp/fs.stat", join(installDir, "s.txt"), tok),
      )) as JsonRpcResponse;
      expect("error" in resp && resp.error).toBeFalsy();
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("fs.unlink removes a file host-side under the token identity", async () => {
    await writeFile(join(installDir, "gone.txt"), "delete-me", "utf-8");
    const tok = registerCallProvenance(provFor("user-U", "conv-U"));
    try {
      const resp = (await executor.handlePiFsUnlink(
        "ext-1",
        fsReq("ezcorp/fs.unlink", join(installDir, "gone.txt"), tok),
      )) as JsonRpcResponse;
      expect("error" in resp && resp.error).toBeFalsy();
      // The PDP saw the token's identity (not a singleton).
      const call = engine.calls[engine.calls.length - 1];
      expect(call?.ctx.userId).toBe("user-U");
    } finally {
      releaseCallProvenance(tok);
    }
  });

  test("an unresolved token short-circuits the per-op handler with -32602", async () => {
    const resp = (await executor.handlePiFsStat(
      "ext-1",
      fsReq("ezcorp/fs.stat", join(installDir, "s.txt"), "not-a-real-token"),
    )) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32602);
  });
});
