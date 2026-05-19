// Regression: granted filesystem dir doesn't exist yet (bootstrap).
//
// extension-author's "cannot access its own draft directory" deadlock:
// a bundled extension granted `$CWD/.ezcorp/extension-data/<name>` on a
// fresh project (where `.ezcorp/` is gitignored/absent) had its ONLY
// grant silently voided — `checkPrefixForWrite` did
// `realpath(prefix)`, ENOENT threw, the prefix was skipped, the first
// `fs.mkdir` was denied, and `gateWritePath` ran `denyAndDisable`,
// disabling the extension and hanging the chat with no error.
//
// The fix routes the prefix through `resolveGrantPrefixCanonical`,
// which canonicalizes the lowest EXISTING ancestor and re-appends the
// not-yet-created tail (symlink-safe — a missing component can't hold a
// symlink). These drive the REAL `handlePiFsMkdir/Write/Exists`
// handlers (the surface the bug corrupted) with a grant pointing at a
// not-yet-created subtree and a SEPARATE install dir (so the
// install-dir implicit-allow can't mask the prefix path — mirroring
// reality: extension-author installs under docs/, drafts live under
// .ezcorp/). allow-all engine + a registered call-provenance token, so
// `denyAndDisable` is never reached (no DB needed).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
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

function makeRegistry(grantDir: string, installDir: string): ExtensionRegistry {
  return {
    getGrantedPermissions: (_id: string) => ({
      grantedAt: {},
      filesystem: [grantDir],
    }),
    getManifest: (_id: string) => ({ schemaVersion: 2, name: "ext" }),
    getInstallPath: (_id: string) => installDir,
    getRegisteredTool: (_name: string) => null,
  } as unknown as ExtensionRegistry;
}

function prov(): CallProvenance {
  return {
    onBehalfOf: "user-A",
    conversationId: "conv-A",
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

describe("fs-handler — granted dir not created yet (bootstrap deadlock)", () => {
  let projectRoot: string;
  let installDir: string;
  let grantDir: string;
  let executor: ToolExecutor;
  let engine: ReturnType<typeof createStubPermissionEngine>;

  beforeEach(async () => {
    _resetCallProvenanceForTests();
    // Real, separate dirs. The grant points DEEP inside projectRoot at
    // a subtree that does NOT exist yet — the exact bootstrap shape of
    // `$CWD/.ezcorp/extension-data/extension-author`.
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), "ezc-boot-")));
    installDir = await realpath(await mkdtemp(join(tmpdir(), "ezc-inst-")));
    grantDir = join(projectRoot, ".ezcorp", "extension-data", "extension-author");
    engine = createStubPermissionEngine("allow-all");
    executor = new ToolExecutor(
      makeRegistry(grantDir, installDir),
      engine,
    );
  });

  afterEach(async () => {
    _resetCallProvenanceForTests();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  });

  test("mkdir → write → exists under a granted-but-uncreated subtree all succeed", async () => {
    const tok = registerCallProvenance(prov());
    try {
      const draftDir = join(grantDir, "drafts", "user-A", "draft-1");

      const mk = (await executor.handlePiFsMkdir(
        "ext-1",
        fsReq("ezcorp/fs.mkdir", draftDir, tok, { recursive: true }),
      )) as JsonRpcResponse;
      expect("error" in mk && mk.error).toBeFalsy();

      const file = join(draftDir, "ezcorp.config.ts");
      const wr = (await executor.handlePiFsWrite(
        "ext-1",
        fsReq("ezcorp/fs.write", file, tok, {
          content: "export default {};\n",
          encoding: "utf-8",
        }),
      )) as JsonRpcResponse;
      expect("error" in wr && wr.error).toBeFalsy();
      // The host actually wrote it.
      expect(await readFile(file, "utf-8")).toBe("export default {};\n");

      const ex = (await executor.handlePiFsExists(
        "ext-1",
        fsReq("ezcorp/fs.exists", file, tok),
      )) as JsonRpcResponse;
      expect("error" in ex && ex.error).toBeFalsy();
      expect((ex.result as { exists: boolean }).exists).toBe(true);

      // The PDP was consulted (gate reached), never short-circuited to
      // a deny+disable. Every call resolved the real provenance.
      expect(engine.calls.length).toBeGreaterThanOrEqual(3);
      for (const c of engine.calls) expect(c.ctx.userId).toBe("user-A");
    } finally {
      releaseCallProvenance(tok);
    }
  });

  // NB: the "sibling outside the grant is still denied" / no-widening
  // guarantee is asserted DB-free at the pure-helper level in
  // `extension-permissions.test.ts` (`checkFilesystemPermission` —
  // "sibling outside the granted subtree is still DENIED"). It is
  // deliberately NOT re-tested here: the deny path runs
  // `denyAndDisable`, which needs a DB this no-DB harness doesn't wire
  // (same design as `tool-executor.fs-provenance.test.ts`).

  test("install-dir implicit-allow still works (regression guard)", async () => {
    const tok = registerCallProvenance(prov());
    try {
      // Directly under the (existing) install dir — the implicit-allow
      // branch in checkPrefixForWrite is unchanged by the fix.
      const underInstall = join(installDir, "f.txt");
      const resp = (await executor.handlePiFsWrite(
        "ext-1",
        fsReq("ezcorp/fs.write", underInstall, tok, {
          content: "ok",
          encoding: "utf-8",
        }),
      )) as JsonRpcResponse;
      expect("error" in resp && resp.error).toBeFalsy();
      expect(await readFile(underInstall, "utf-8")).toBe("ok");
    } finally {
      releaseCallProvenance(tok);
    }
  });
});
