// GAP 1 regression coverage — fs.* reverse-RPC provenance.
//
// `ezcorp/fs.{write,mkdir,...}` handlers used to build their
// FsHandlerContext from the process-wide `ToolExecutor.currentUserId` /
// `currentConversationId` singletons. That is the *latent* half of the
// reverse-RPC provenance bug: `extension-author.create_extension`
// drives host-mediated `fsMkdir` / `fsWrite`, so under concurrency the
// PDP (`engine.authorize`) and the audit log were misattributed to
// whatever forward call last touched the singleton — exactly the
// `extension-author__create_extension` 90s-hang / wrong-owner class.
//
// The fix routes fs.* provenance through the same host-issued
// `ezCallId` correlation token every other capability handler uses
// (`resolveReverseRpcMeta`). These tests prove:
//
//   1. fs.write resolves `ctx.userId` / `ctx.conversationId` from the
//      token snapshot, NOT the singleton.
//   2. fs.mkdir does the same.
//   3. Concurrency: two in-flight tokens for two different users each
//      resolve to the correct user (no singleton bleed).
//   4. An unresolved / missing token → -32602 (fast fail, never hang).
//   5. An ownerless background-fire token → -32106 (clean soft-fail).
//
// We don't run the real subprocess. We invoke the handler methods
// directly with a request carrying `params._meta.ezCallId`, and assert
// on the recording PermissionEngine stub's tape — that is precisely
// the surface the misattribution bug corrupted.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../tool-executor";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import {
  registerCallProvenance,
  registerFireCallProvenance,
  releaseCallProvenance,
  _resetCallProvenanceForTests,
  type CallProvenance,
} from "../call-provenance";
import type { ExtensionRegistry } from "../registry";
import type { JsonRpcRequest, JsonRpcResponse } from "../types";

// ── Stub registry — grants filesystem over a real temp dir so the
//    path-allowlist passes and the gate reaches `engine.authorize`,
//    which is the surface the provenance bug corrupted. The allowlist
//    is keyed on the extension's grant + install path (NOT the user),
//    so resolving real provenance never weakens it. ───────────────────

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
  ezCallId: string | undefined,
  extra: Record<string, unknown> = {},
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      path,
      ...extra,
      ...(ezCallId ? { _meta: { ezCallId } } : {}),
    },
  };
}

describe("ToolExecutor fs.* reverse-RPC provenance (GAP 1)", () => {
  let tmp: string;
  let installDir: string;
  let registry: ExtensionRegistry;
  let engine: ReturnType<typeof createStubPermissionEngine>;
  let executor: ToolExecutor;

  beforeEach(async () => {
    _resetCallProvenanceForTests();
    tmp = await mkdtemp(join(tmpdir(), "ezcorp-fs-prov-"));
    // realpath: macOS /tmp is a symlink; checkPrefixForWrite realpaths
    // the install dir, so the grant must be the resolved form too.
    installDir = await realpath(tmp);
    registry = makeStubRegistry(installDir);
    engine = createStubPermissionEngine("allow-all");
    executor = new ToolExecutor(registry, engine);
    // Poison the singletons so a regression to the old behavior would
    // surface as the WRONG user, not an absent one.
    executor.setCurrentUserId("SINGLETON-LEAK-USER");
    executor.setCurrentConversationId("SINGLETON-LEAK-CONV");
  });

  afterEach(async () => {
    _resetCallProvenanceForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  test("fs.write resolves userId/conversationId from the token, not the singleton", async () => {
    const ezCallId = registerCallProvenance(provFor("user-A", "conv-A"));
    try {
      const resp = await executor.handlePiFsWrite(
        "ext-1",
        fsReq("ezcorp/fs.write", join(installDir, "out.txt"), ezCallId, {
          content: "hello",
          encoding: "utf-8",
        }),
      );
      // Success (no error) — the write completed.
      expect("error" in resp && resp.error).toBeFalsy();
      // The PDP saw the TOKEN's identity, not the poisoned singleton.
      const call = engine.calls[engine.calls.length - 1]!;
      expect(call.ctx.userId).toBe("user-A");
      expect(call.ctx.conversationId).toBe("conv-A");
      expect(call.ctx.userId).not.toBe("SINGLETON-LEAK-USER");
    } finally {
      releaseCallProvenance(ezCallId);
    }
  });

  test("fs.mkdir resolves userId/conversationId from the token", async () => {
    const ezCallId = registerCallProvenance(provFor("user-M", "conv-M"));
    try {
      const resp = await executor.handlePiFsMkdir(
        "ext-1",
        fsReq("ezcorp/fs.mkdir", join(installDir, "sub", "dir"), ezCallId, {
          recursive: true,
        }),
      );
      expect("error" in resp && resp.error).toBeFalsy();
      const call = engine.calls[engine.calls.length - 1]!;
      expect(call.ctx.userId).toBe("user-M");
      expect(call.ctx.conversationId).toBe("conv-M");
    } finally {
      releaseCallProvenance(ezCallId);
    }
  });

  test("concurrency: two in-flight tokens for two users each resolve correctly", async () => {
    const tokA = registerCallProvenance(provFor("user-A", "conv-A"));
    const tokB = registerCallProvenance(provFor("user-B", "conv-B"));
    try {
      // Both reverse-RPCs are "in flight" at the same time — the old
      // singleton would smear whichever fired last across both.
      const [respA, respB] = await Promise.all([
        executor.handlePiFsMkdir(
          "ext-1",
          fsReq("ezcorp/fs.mkdir", join(installDir, "a"), tokA),
        ),
        executor.handlePiFsMkdir(
          "ext-1",
          fsReq("ezcorp/fs.mkdir", join(installDir, "b"), tokB),
        ),
      ]);
      expect("error" in respA && respA.error).toBeFalsy();
      expect("error" in respB && respB.error).toBeFalsy();
      const usersSeen = engine.calls.map((c) => c.ctx.userId).sort();
      expect(usersSeen).toEqual(["user-A", "user-B"]);
      // Neither call leaked the poisoned singleton identity.
      expect(usersSeen).not.toContain("SINGLETON-LEAK-USER");
    } finally {
      releaseCallProvenance(tokA);
      releaseCallProvenance(tokB);
    }
  });

  test("unresolved / missing token → -32602 (fast fail, never hang)", async () => {
    // No token registered AND none echoed: a regression / orphaned
    // subprocess. Must fail fast, not silently act as "unknown".
    const resp = (await executor.handlePiFsWrite(
      "ext-1",
      fsReq("ezcorp/fs.write", join(installDir, "x.txt"), undefined),
    )) as JsonRpcResponse;
    expect(resp.error?.code).toBe(-32602);
    // And a stale / unknown token id is treated the same way.
    const resp2 = (await executor.handlePiFsWrite(
      "ext-1",
      fsReq("ezcorp/fs.write", join(installDir, "x.txt"), "not-a-real-token"),
    )) as JsonRpcResponse;
    expect(resp2.error?.code).toBe(-32602);
    // The PDP was NEVER reached — no misattributed audit row.
    expect(engine.calls.length).toBe(0);
  });

  test("ownerless background-fire token → -32106 (clean soft-fail)", async () => {
    const fireTok = registerFireCallProvenance({
      onBehalfOf: null,
      conversationId: null,
      runId: null,
      parentCallId: null,
      actorExtensionId: "ext-1",
      kind: "schedule",
      ownerless: true,
    });
    try {
      const resp = (await executor.handlePiFsMkdir(
        "ext-1",
        fsReq("ezcorp/fs.mkdir", join(installDir, "owned"), fireTok),
      )) as JsonRpcResponse;
      expect(resp.error?.code).toBe(-32106);
      expect(engine.calls.length).toBe(0);
    } finally {
      releaseCallProvenance(fireTok);
    }
  });
});
