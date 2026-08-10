/**
 * The reserved carve-out is NOT a grant escape.
 *
 * `read_files`-style extensions walk the project root and `fs.list`
 * every directory under it. In the SHIPPED DOCKER LAYOUT
 * (`Dockerfile:253` — `EZCORP_DB_PATH=/app/data/ezcorp` with project
 * root `/app`) the PGlite datadir sits INSIDE the project root, so the
 * walk necessarily lists it. `permissions.ts:203-215` deliberately
 * carves that dir OUT of the `$CWD` grant (defence-in-depth for the DB
 * + JWT secret), and `checkFilesystemPermission` used to return the
 * SAME `{allowed:false}` for that carve-out as for a genuine
 * out-of-grant escape. `fs-handler.ts:541` then ran `denyAndDisable`,
 * so the first CORRECT run of the extension permanently bricked it:
 * `enabled=false` + a `SecurityViolation` row, and
 * `POST /api/extensions/:id/activate` answers 403 "Cannot re-enable
 * extension with security violations" forever after.
 *
 * The two denials are now distinct VALUES
 * (`FilesystemDenial.kind`), and only `out-of-grant` disables. This
 * file drives the REAL `ToolExecutor.handlePiFs*` handlers against a
 * REAL pglite DB + REAL registry so `enabled` and the violation list
 * are read back from actual rows — the same shape as
 * `seam-permission-disable-integration.test.ts`.
 *
 * Layout under test is the Docker one, NOT the dev default. The dev
 * default (`$HOME/ez-corp/.data`) lives OUTSIDE the project root, so a
 * denial there is a legitimate out-of-grant escape and would never have
 * caught this bug.
 */

import { test, expect, describe, beforeEach, afterAll, beforeAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  getTestDb,
  mockDbConnection,
  mockRealSettings,
} from "./helpers/test-pglite";

// ── The Docker layout (Dockerfile:253) ────────────────────────────────
//
// `/app`                 → project root, and the whole of the `$CWD` grant
// `/app/data/ezcorp`     → EZCORP_DB_PATH (PGlite datadir) — RESERVED
// `/app/data/backups`    → snapshot sibling               — RESERVED
// `/app/data/extensions` → MCP/extension install base     — allowed
// `/app/src`             → ordinary project content       — allowed
//
// Built before the mock factories below run so the factory closes over
// real, already-created paths.
const APP_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ezc-app-")));
const APP_DATA = join(APP_ROOT, "data");
const RESERVED_DB_DIR = join(APP_DATA, "ezcorp");
const RESERVED_BACKUPS_DIR = join(APP_DATA, "backups");
const APP_SRC = join(APP_ROOT, "src");
// Outside the project root entirely — the genuine-escape control.
const OUTSIDE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ezc-outside-")));

mkdirSync(join(APP_ROOT, "docs", "extensions", "examples"), { recursive: true });
mkdirSync(RESERVED_DB_DIR, { recursive: true });
mkdirSync(RESERVED_BACKUPS_DIR, { recursive: true });
mkdirSync(join(APP_DATA, "extensions"), { recursive: true });
mkdirSync(APP_SRC, { recursive: true });
writeFileSync(join(RESERVED_DB_DIR, "PG_VERSION"), "15\n");
writeFileSync(join(APP_SRC, "index.ts"), "export {};\n");
writeFileSync(join(OUTSIDE_ROOT, "secret.txt"), "secret");

// ── Module-level mocks (BEFORE importing anything that touches the DB) ──

mockDbConnection();
mockRealSettings();
// `src/db/connection.ts:28` freezes `DB_PATH` from `EZCORP_DB_PATH` at
// module load, and `preload.ts` already loaded it, so the env var can no
// longer move the reserved set. Override the ONE export that computes it
// (bun's `mock.module` merges — the `getDb` etc. from `mockDbConnection`
// above survive) so the reserved set is exactly the Docker one.
mock.module("../db/connection", () => ({
  getDbMaskDirs: () => [RESERVED_DB_DIR, RESERVED_BACKUPS_DIR],
}));

mock.module("../extensions/subprocess", () => ({
  ExtensionProcess: class {
    isRunning = false;
    kill() {}
  },
  parseMemoryLimit: (_: string) => undefined,
}));

import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { getSecurityViolations } from "../extensions/security";
import { __resetProjectRootCacheForTests } from "../extensions/bundled";
import {
  registerCallProvenance,
  releaseCallProvenance,
  _resetCallProvenanceForTests,
  type CallProvenance,
} from "../extensions/call-provenance";
import { extensions, toolCalls, settings, auditLog, users } from "../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionManifestV2, JsonRpcRequest, JsonRpcResponse } from "../extensions/types";

const EXT_NAME = "project-walker";
let installDir: string;
let extensionId: string;
/** A REAL users row — `audit_log.user_id` is FK-constrained to it, and
 *  `insertAuditEntry` swallows its own write failures, so a synthetic id
 *  would silently produce zero audit rows and pass a weaker assertion. */
let userId: string;

function buildManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: "1.0.0",
    description: "walks the project root like ez-factory's read_files",
    author: { name: "test" },
    entrypoint: "./index.js",
    tools: [
      {
        name: "read_files",
        description: "Walk the project",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
    permissions: { filesystem: ["$CWD"] },
  };
}

function prov(): CallProvenance {
  return {
    onBehalfOf: userId,
    conversationId: "conv-A",
    runId: null,
    parentCallId: null,
    actorExtensionId: EXT_NAME,
    kind: "tool",
    ownerless: false,
  };
}

function fsReq(
  path: string,
  ezCallId: string,
  extra: Record<string, unknown> = {},
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/fs.list",
    params: { path, ...extra, _meta: { ezCallId } },
  };
}

/** Run `fn` with a live provenance token so the real handlers resolve a user. */
async function withProvenance<T>(fn: (tok: string) => Promise<T>): Promise<T> {
  const tok = registerCallProvenance(prov());
  try {
    return await fn(tok);
  } finally {
    releaseCallProvenance(tok);
  }
}

const savedProjectRoot = process.env.EZCORP_PROJECT_ROOT;

/**
 * Explicit hook timeout. `scripts/test.sh:109` runs the pool with
 * `--timeout 30000` because a DB-heavy file shares the host with parallel
 * PGlite siblings, but a bare targeted `bun test ./this-file` gets bun's
 * 5s default — and `setupTestDb()` replays the migrated-snapshot build on
 * a cold process. When that hook times out the file reports a bare
 * `0 pass / 1 fail` with no test name, which reads as a broken suite
 * rather than a timeout. Pinning it here makes the targeted run behave
 * like the pool run.
 */
const DB_HOOK_TIMEOUT_MS = 30_000;

beforeAll(async () => {
  process.env.EZCORP_PROJECT_ROOT = APP_ROOT;
  __resetProjectRootCacheForTests();
  await setupTestDb();
}, DB_HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (savedProjectRoot === undefined) delete process.env.EZCORP_PROJECT_ROOT;
  else process.env.EZCORP_PROJECT_ROOT = savedProjectRoot;
  __resetProjectRootCacheForTests();
  _resetCallProvenanceForTests();
  ExtensionRegistry.resetInstance();
  restoreModuleMocks();
  await closeTestDb();
  rmSync(APP_ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
}, DB_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  _resetCallProvenanceForTests();
  ExtensionRegistry.resetInstance();
  const db = getTestDb();
  await db.delete(toolCalls);
  await db.delete(extensions);
  await db.delete(settings);
  await db.delete(auditLog);
  await db.delete(users);

  const userRows = await db
    .insert(users)
    .values({
      email: `walker-${Date.now()}-${Math.random()}@example.test`,
      passwordHash: "x",
      name: "Walker",
    })
    .returning({ id: users.id });
  userId = userRows[0]!.id;

  // The extension installs under `/app/data/extensions/<name>` — the
  // production Docker install base, a SIBLING of the reserved DB dir.
  installDir = join(APP_DATA, "extensions", EXT_NAME);
  mkdirSync(installDir, { recursive: true });

  const rows = await db
    .insert(extensions)
    .values({
      name: EXT_NAME,
      version: "1.0.0",
      description: "walker",
      manifest: buildManifest(),
      source: `local:${installDir}`,
      installPath: installDir,
      enabled: true,
      // The real bundled grant: the whole project root.
      grantedPermissions: { filesystem: ["$CWD"], grantedAt: {} } as never,
    })
    .returning({ id: extensions.id });
  extensionId = rows[0]!.id;
}, DB_HOOK_TIMEOUT_MS);

async function isEnabled(): Promise<boolean> {
  const db = getTestDb();
  const row = await db.select().from(extensions).where(eq(extensions.id, extensionId));
  return row[0]!.enabled;
}

describe("reserved carve-out denial is NOT a security violation", () => {
  test("fs.list on the Docker PGlite datadir denies WITHOUT disabling the extension", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(RESERVED_DB_DIR, tok)),
    )) as JsonRpcResponse;

    // Still DENIED — the platform's own state stays unreachable.
    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32001);
    // ... but it is an ORDINARY denial the extension can handle, not a
    // deny-and-disable. `read_files` turns this into skipped[unreadable].
    expect(res.error!.message).not.toContain("disabled");

    expect(await isEnabled()).toBe(true);
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);
  });

  test("the backups sibling carve-out also denies without disabling", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(RESERVED_BACKUPS_DIR, tok)),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(true);
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);
  });

  test("the walk survives: listing the reserved dir then a real dir still works", async () => {
    // This is the end-to-end shape of the bug. Pre-fix the FIRST list
    // bricked the extension and every later call 403'd.
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(RESERVED_DB_DIR, tok)),
    );

    const ok = (await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(APP_SRC, tok)),
    )) as JsonRpcResponse;

    expect(ok.error).toBeUndefined();
    expect(
      (ok.result as { entries: Array<{ name: string }> }).entries.map((e) => e.name),
    ).toContain("index.ts");
    expect(await isEnabled()).toBe(true);
  });

  test("the carve-out denial is still AUDITED — it is observable, not silent", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(RESERVED_DB_DIR, tok)),
    );

    const db = getTestDb();
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "ext:perm:denied"));
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("reserved-path");
    expect(meta.capabilityKind).toBe("fs.list");
    expect(meta.capabilityValue).toBe(RESERVED_DB_DIR);
    expect(rows[0]!.target).toBe(extensionId);
    // Attributed to the real caller, not "unknown" — the row is usable
    // for forensics.
    expect(rows[0]!.userId).toBe(userId);
  });

  test("a missing path inside the grant is plain ENOENT — not reserved, not a violation", async () => {
    // The third denial kind. It must NOT borrow the carve-out's -32001
    // "reserved by the platform" message (that would break the ENOENT
    // contract callers expect AND write a bogus audit row), and it must
    // NOT disable.
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const missing = join(APP_SRC, "no-such-file.ts");
    const res = (await withProvenance((tok) =>
      executor.handlePiFsRead(extensionId, {
        jsonrpc: "2.0",
        id: 7,
        method: "ezcorp/fs.read",
        params: { path: missing, _meta: { ezCallId: tok } },
      }),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32000);
    expect(res.error!.message).toContain("ENOENT");
    expect(res.error!.message).not.toContain("reserved");

    expect(await isEnabled()).toBe(true);
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);
    const db = getTestDb();
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "ext:perm:denied"));
    expect(rows).toHaveLength(0);
  });

  test("write-side: mkdir inside the reserved dir denies without disabling", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "ezcorp/fs.mkdir",
      params: { path: join(RESERVED_DB_DIR, "evil"), recursive: true },
    };
    const res = (await withProvenance((tok) =>
      executor.handlePiFsMkdir(extensionId, {
        ...req,
        params: { ...(req.params as object), _meta: { ezCallId: tok } },
      }),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(true);
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);
  });

  test("unlink of a file inside the reserved dir denies, leaves the file, and does not disable", async () => {
    // `handleFsUnlinkRpc` does NOT go through `gatePath`/`gateWritePath`
    // — it gates on the parent's realpath itself (`fs-handler.ts:456`)
    // so a symlink leaf is never resolved to its target — and then
    // routes its own refusal through `refuseFs` (`fs-handler.ts:458`).
    // That makes it the one fs op with a SECOND, independent call site
    // into the deny-and-disable decision; a `denial`-blind refusal there
    // would brick a project-root-walking extension that tidies up files
    // (file-organizer's whole job) the moment its walk reached
    // `/app/data/ezcorp`.
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    // A file of our own inside the reserved dir, so the assertion that
    // it SURVIVES is about this call and not about fixture ordering.
    const victim = join(RESERVED_DB_DIR, "unlink-me.db");
    writeFileSync(victim, "rows");
    try {
      const res = (await withProvenance((tok) =>
        executor.handlePiFsUnlink(extensionId, {
          jsonrpc: "2.0",
          id: 10,
          method: "ezcorp/fs.unlink",
          params: { path: victim, _meta: { ezCallId: tok } },
        }),
      )) as JsonRpcResponse;

      // Denied, with the reserved wording — not the escape wording.
      expect(res.error!.code).toBe(-32001);
      expect(res.error!.message).toContain("reserved by the EZCorp platform");
      expect(res.error!.message).not.toContain("disabled");
      // The deny is REAL: the platform's file is still on disk. Without
      // this the test would pass against a handler that refused on paper
      // and unlinked anyway.
      expect(existsSync(victim)).toBe(true);

      // …and it is an ordinary denial, not a violation.
      expect(await isEnabled()).toBe(true);
      expect(await getSecurityViolations(extensionId)).toHaveLength(0);

      // Still observable — same audit contract as the read-side gates.
      const db = getTestDb();
      const rows = await db.select().from(auditLog).where(eq(auditLog.action, "ext:perm:denied"));
      expect(rows).toHaveLength(1);
      const meta = rows[0]!.metadata as Record<string, unknown>;
      expect(meta.reason).toBe("reserved-path");
      expect(meta.capabilityKind).toBe("unlink");
      expect(meta.capabilityValue).toBe(victim);
    } finally {
      rmSync(victim, { force: true });
    }
  });

  test("exists probe on the reserved dir denies without disabling", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsExists(extensionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "ezcorp/fs.exists",
        params: { path: join(RESERVED_DB_DIR, "PG_VERSION"), _meta: { ezCallId: tok } },
      }),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(true);
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);
  });
});

describe("the deprecated `ezcorp/fs` path-check shim makes the same distinction", () => {
  // The shim is a SECOND, older code path to `denyAndDisable`. Leaving
  // the conflation there would keep the bug alive for any extension
  // still on the pre-Phase-3 API.
  const shimReq = (operation: string, path: string): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id: 9,
    method: "ezcorp/fs",
    params: { operation, path },
  });

  test("a reserved-dir check denies without disabling, and is audited", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = await executor.handlePiFs(extensionId, shimReq("read", RESERVED_DB_DIR));

    expect(res.error!.code).toBe(-32001);
    expect(res.error!.message).not.toContain("disabled");
    expect(await isEnabled()).toBe(true);
    expect(await getSecurityViolations(extensionId)).toHaveLength(0);

    const db = getTestDb();
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "ext:perm:denied"));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as Record<string, unknown>).reason).toBe("reserved-path");
  });

  test("an out-of-grant check still disables", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = await executor.handlePiFs(
      extensionId,
      shimReq("read", join(OUTSIDE_ROOT, "secret.txt")),
    );

    expect(res.error!.code).toBe(-32001);
    expect(res.error!.message).toContain("disabled");
    expect(await isEnabled()).toBe(false);
    expect(await getSecurityViolations(extensionId)).toHaveLength(1);
  });
});

describe("a genuine out-of-grant escape STILL disables (the control's whole purpose)", () => {
  test("fs.list outside the project root disables the extension and records a violation", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(OUTSIDE_ROOT, tok)),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(res.error!.message).toContain("Extension has been disabled");

    expect(await isEnabled()).toBe(false);
    const violations = await getSecurityViolations(extensionId);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("fs.list");
  });

  test("fs.read outside the project root disables the extension", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsRead(extensionId, {
        jsonrpc: "2.0",
        id: 4,
        method: "ezcorp/fs.read",
        params: { path: join(OUTSIDE_ROOT, "secret.txt"), _meta: { ezCallId: tok } },
      }),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(false);
    expect(await getSecurityViolations(extensionId)).toHaveLength(1);
  });

  test("fs.write outside the project root disables the extension", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsWrite(extensionId, {
        jsonrpc: "2.0",
        id: 5,
        method: "ezcorp/fs.write",
        params: {
          path: join(OUTSIDE_ROOT, "planted.txt"),
          content: "x",
          encoding: "utf-8",
          _meta: { ezCallId: tok },
        },
      }),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(false);
    expect(await getSecurityViolations(extensionId)).toHaveLength(1);
  });

  test("fs.exists probing outside the project root disables the extension", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    const res = (await withProvenance((tok) =>
      executor.handlePiFsExists(extensionId, {
        jsonrpc: "2.0",
        id: 6,
        method: "ezcorp/fs.exists",
        params: { path: join(OUTSIDE_ROOT, "secret.txt"), _meta: { ezCallId: tok } },
      }),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(false);
    expect(await getSecurityViolations(extensionId)).toHaveLength(1);
  });

  test("unlink outside the project root disables the extension and records a violation", async () => {
    // The control for the reserved-dir unlink above: the SAME line
    // (`fs-handler.ts:458`) must still escalate when the denial really
    // is an escape. An extension deleting files outside its grant is
    // the destructive end of the threat model.
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    // Deliberately NOT named "unlink-*": the violation `reason` embeds the
    // requested path, so a filename containing the op label would satisfy
    // the `toContain("unlink on ")` assertion below no matter what label
    // the handler actually passed.
    const victim = join(OUTSIDE_ROOT, "external-target.txt");
    writeFileSync(victim, "external");
    try {
      const res = (await withProvenance((tok) =>
        executor.handlePiFsUnlink(extensionId, {
          jsonrpc: "2.0",
          id: 11,
          method: "ezcorp/fs.unlink",
          params: { path: victim, _meta: { ezCallId: tok } },
        }),
      )) as JsonRpcResponse;

      expect(res.error!.code).toBe(-32001);
      expect(res.error!.message).toContain("Extension has been disabled");
      // The file outside the grant is untouched.
      expect(existsSync(victim)).toBe(true);

      expect(await isEnabled()).toBe(false);
      const violations = await getSecurityViolations(extensionId);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain("unlink on ");
      expect(violations[0]!.reason).toContain(victim);
    } finally {
      rmSync(victim, { force: true });
    }
  });

  test("a symlink escape out of the grant still disables (realpath is not bypassed)", async () => {
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    const executor = new ToolExecutor(registry, createStubPermissionEngine());

    // A symlink INSIDE the grant pointing OUT of it.
    const link = join(APP_SRC, "escape-hatch");
    rmSync(link, { force: true });
    require("node:fs").symlinkSync(OUTSIDE_ROOT, link);

    const res = (await withProvenance((tok) =>
      executor.handlePiFsList(extensionId, fsReq(link, tok)),
    )) as JsonRpcResponse;

    expect(res.error!.code).toBe(-32001);
    expect(await isEnabled()).toBe(false);
    expect(await getSecurityViolations(extensionId)).toHaveLength(1);
    rmSync(link, { force: true });
  });
});
