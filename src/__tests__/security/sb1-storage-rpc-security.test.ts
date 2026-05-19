// Regression tests for sec-SB1: the `ezcorp/storage` reverse-RPC handler in
// `src/extensions/storage-handler.ts` must enforce
//
//   (1) cross-extension isolation (one extension cannot read / write / list
//       another extension's keys), even inside the same scope;
//   (2) scope isolation — `conversation` storage is partitioned by
//       conversationId and `user` storage by userId, so an extension with
//       legitimate access to conversation A cannot read conversation B;
//   (3) per-extension quota enforcement (manifest `resources.storage`);
//   (4) per-extension token-bucket rate limiting
//       (MAX_OPS_PER_SECOND = 50);
//   (5) key validation — empty/too-long/bad-character/reserved-prefix keys
//       are rejected;
//   (6) batch operation limit — at most 100 ops per `batch` request;
//   (7) encryption flag — when `encrypted: true`, the ciphertext is what
//       lands in the DB, never the plaintext.
//
// Every item above is already implemented in `storage-handler.ts`; these
// tests lock that behavior in so future refactors can't quietly break it.
//
// Strategy: run the handler against a real PGlite-backed drizzle instance
// with a freshly-inserted `extensions` and `conversations` schema, feed it
// `JsonRpcRequest` objects, and assert on the returned `JsonRpcResponse`.
// No source is mocked beyond the db connection — the handler, the drizzle
// queries, and the encryption module all execute for real.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "../helpers/test-pglite";
import { restoreModuleMocks } from "../helpers/mock-cleanup";

// Encryption module reads .pi-secret / .pi-salt from CWD at first use — point
// it at deterministic values so this test file never touches the real files.
process.env.EZCORP_ENCRYPTION_SECRET ??= "0".repeat(64);
process.env.EZCORP_ENCRYPTION_SALT ??= "sb1-test-salt";

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

// Dynamic imports AFTER mocks
const { handleStorageRpc } = await import("../../extensions/storage-handler");
const { getDb } = await import("../../db/connection");
const { extensions, conversations, projects, extensionStorage } = await import("../../db/schema");
const { eq, and } = await import("drizzle-orm");

import type { JsonRpcRequest } from "../../extensions/types";
import type { StorageContext } from "../../extensions/storage-handler";
import type { ExtensionManifestV2, ExtensionPermissions } from "../../extensions/types";

// ── Test fixtures ──────────────────────────────────────────────────

function makeManifest(name: string, quota = "5MB"): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name,
    version: "1.0.0",
    description: `test manifest for ${name}`,
    author: { name: "test" },
    resources: { storage: quota },
  } as unknown as ExtensionManifestV2;
}

function makePerms(storage = true): ExtensionPermissions {
  return { storage, grantedAt: { storage: Date.now() } };
}

function makeCtx(
  manifest: ExtensionManifestV2,
  overrides: Partial<StorageContext> = {},
): StorageContext {
  return {
    conversationId: overrides.conversationId ?? "conv-x",
    userId: overrides.userId ?? "user-x",
    manifest: overrides.manifest ?? manifest,
    grantedPermissions: overrides.grantedPermissions ?? makePerms(true),
  };
}

let counter = 0;
function uniqueExtId(prefix = "ext"): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

async function insertExtension(id: string, manifest: ExtensionManifestV2): Promise<void> {
  await getDb().insert(extensions).values({
    id,
    name: id, // unique constraint
    version: manifest.version,
    description: manifest.description,
    manifest,
    source: `test:${id}`,
    installPath: `/tmp/${id}`,
    enabled: true,
    grantedPermissions: makePerms(true),
  } as any);
}

async function insertProject(id: string): Promise<void> {
  await getDb().insert(projects).values({ id, name: id, path: `/tmp/${id}` } as any);
}

async function insertConversation(id: string, projectId: string): Promise<void> {
  await getDb().insert(conversations).values({ id, projectId, title: "test" } as any);
}

function rpc(action: string, params: Record<string, unknown> = {}, id: number | string = 1): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "ezcorp/storage",
    params: { action, ...params },
  };
}

// ── Suite ───────────────────────────────────────────────────────────
//
// One top-level setup for the whole file — nesting multiple setup/teardown
// cycles causes restoreModuleMocks() from one describe's afterAll to undo
// the db/connection mock for subsequent describes, leaving `getDb()`
// pointing at the real uninitialized module.

// Cross-extension fixtures
let extA: string;
let extB: string;
let manifestA: ExtensionManifestV2;
let manifestB: ExtensionManifestV2;

// Scope fixtures
let extScope: string;
let manifestScope: ExtensionManifestV2;
let projId: string;
let c1: string;
let c2: string;

// Policy fixtures (quota/rate-limit/keys/batch)
let extPolicy: string;
let manifestPolicy: ExtensionManifestV2;

beforeAll(async () => {
  await setupTestDb();

  extA = uniqueExtId("extA");
  extB = uniqueExtId("extB");
  manifestA = makeManifest(extA);
  manifestB = makeManifest(extB);
  await insertExtension(extA, manifestA);
  await insertExtension(extB, manifestB);

  extScope = uniqueExtId("ext-scope");
  manifestScope = makeManifest(extScope);
  await insertExtension(extScope, manifestScope);

  projId = uniqueExtId("proj");
  await insertProject(projId);
  c1 = uniqueExtId("conv1");
  c2 = uniqueExtId("conv2");
  await insertConversation(c1, projId);
  await insertConversation(c2, projId);

  const { conversationExtensions } = await import("../../db/schema");
  await getDb().insert(conversationExtensions).values([
    { conversationId: c1, extensionId: extScope },
    { conversationId: c2, extensionId: extScope },
  ] as any);

  extPolicy = uniqueExtId("ext-policy");
  // Tight 10KB quota so the quota test doesn't have to move megabytes.
  manifestPolicy = makeManifest(extPolicy, "10KB");
  await insertExtension(extPolicy, manifestPolicy);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("sec-SB1: storage RPC cross-extension isolation", () => {

  test("extension A cannot read extension B's global keys via 'get'", async () => {
    // Ext B writes a secret.
    const setResp = await handleStorageRpc(extB, rpc("set", { key: "secret", value: "B-only" }), makeCtx(manifestB));
    expect(setResp.error).toBeUndefined();

    // Ext A tries to fetch B's key — same key name, different extension.
    const getResp = await handleStorageRpc(extA, rpc("get", { key: "secret" }), makeCtx(manifestA));
    expect(getResp.error).toBeUndefined();
    expect((getResp.result as any).exists).toBe(false);
    expect((getResp.result as any).value).toBeNull();
  });

  test("extension A cannot overwrite extension B's global keys via 'set'", async () => {
    // Ext B owns key "shared".
    await handleStorageRpc(extB, rpc("set", { key: "shared", value: "B-value" }), makeCtx(manifestB));

    // Ext A writes its own value under the same key — must live in its own
    // partition, not stomp B's.
    const setA = await handleStorageRpc(extA, rpc("set", { key: "shared", value: "A-value" }), makeCtx(manifestA));
    expect(setA.error).toBeUndefined();

    // Ext B still sees its original value.
    const getB = await handleStorageRpc(extB, rpc("get", { key: "shared" }), makeCtx(manifestB));
    expect((getB.result as any).exists).toBe(true);
    expect((getB.result as any).value).toBe("B-value");

    // Ext A sees its own value.
    const getA = await handleStorageRpc(extA, rpc("get", { key: "shared" }), makeCtx(manifestA));
    expect((getA.result as any).value).toBe("A-value");
  });

  test("extension A cannot enumerate extension B's keys via 'list'", async () => {
    // Seed B with three keys, A with one.
    await handleStorageRpc(extB, rpc("set", { key: "list-b-1", value: 1 }), makeCtx(manifestB));
    await handleStorageRpc(extB, rpc("set", { key: "list-b-2", value: 2 }), makeCtx(manifestB));
    await handleStorageRpc(extB, rpc("set", { key: "list-b-3", value: 3 }), makeCtx(manifestB));
    await handleStorageRpc(extA, rpc("set", { key: "list-a-1", value: 1 }), makeCtx(manifestA));

    const listA = await handleStorageRpc(extA, rpc("list", { prefix: "list-b-" }), makeCtx(manifestA));
    expect(listA.error).toBeUndefined();
    expect((listA.result as any).keys).toEqual([]);

    const listB = await handleStorageRpc(extB, rpc("list", { prefix: "list-b-" }), makeCtx(manifestB));
    const keys = (listB.result as any).keys.map((k: any) => k.key).sort();
    expect(keys).toEqual(["list-b-1", "list-b-2", "list-b-3"]);
  });
});

describe("sec-SB1: storage RPC scope isolation", () => {
  test("conversation scope: a value in C1 is invisible from C2", async () => {
    // Write in conversation C1.
    const setResp = await handleStorageRpc(
      extScope,
      rpc("set", { key: "conv-only", value: "c1-secret", scope: "conversation" }),
      makeCtx(manifestScope, { conversationId: c1 }),
    );
    expect(setResp.error).toBeUndefined();

    // Read from C1 → visible.
    const getC1 = await handleStorageRpc(
      extScope,
      rpc("get", { key: "conv-only", scope: "conversation" }),
      makeCtx(manifestScope, { conversationId: c1 }),
    );
    expect((getC1.result as any).exists).toBe(true);
    expect((getC1.result as any).value).toBe("c1-secret");

    // Read from C2 → invisible.
    const getC2 = await handleStorageRpc(
      extScope,
      rpc("get", { key: "conv-only", scope: "conversation" }),
      makeCtx(manifestScope, { conversationId: c2 }),
    );
    expect((getC2.result as any).exists).toBe(false);
  });

  test("user scope: a value for user U1 is invisible to user U2", async () => {
    // Write in user U1's partition (userId is just a scope key — no FK).
    const u1 = "user-sb1-A";
    const u2 = "user-sb1-B";

    const setResp = await handleStorageRpc(
      extScope,
      rpc("set", { key: "my-pref", value: "u1-theme", scope: "user" }),
      makeCtx(manifestScope, { userId: u1 }),
    );
    expect(setResp.error).toBeUndefined();

    const getU1 = await handleStorageRpc(
      extScope,
      rpc("get", { key: "my-pref", scope: "user" }),
      makeCtx(manifestScope, { userId: u1 }),
    );
    expect((getU1.result as any).exists).toBe(true);
    expect((getU1.result as any).value).toBe("u1-theme");

    const getU2 = await handleStorageRpc(
      extScope,
      rpc("get", { key: "my-pref", scope: "user" }),
      makeCtx(manifestScope, { userId: u2 }),
    );
    expect((getU2.result as any).exists).toBe(false);
  });
});

describe("sec-SB1: storage RPC quota, rate-limiting, key validation, batch, encryption", () => {
  test("quota enforcement: writes past the manifest quota return -32002", async () => {
    // 2KB of payload per set × 6 sets = 12KB; quota is 10KB, so at least one
    // of the later writes must be rejected with the quota error.
    const big = "x".repeat(2000);
    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(
        await handleStorageRpc(
          extPolicy,
          rpc("set", { key: `quota-${i}`, value: big }),
          makeCtx(manifestPolicy),
        ),
      );
    }
    const quotaErrors = responses.filter((r) => r.error?.code === -32002);
    expect(quotaErrors.length).toBeGreaterThan(0);
    // The earliest writes should still have succeeded.
    expect(responses[0]!.error).toBeUndefined();
  });

  test("rate limit: >50 ops/second returns -32004 (Rate limited)", async () => {
    // Fresh extension so the token bucket starts full.
    const rlExt = uniqueExtId("ext-rate");
    const rlManifest = makeManifest(rlExt, "100MB");
    await insertExtension(rlExt, rlManifest);
    const ctx = makeCtx(rlManifest);

    let rateLimited = 0;
    // 60 consecutive writes — the 50-token bucket must reject at least a
    // handful of them before `elapsed * 50` refills the bucket meaningfully.
    for (let i = 0; i < 60; i++) {
      const resp = await handleStorageRpc(rlExt, rpc("set", { key: `rl-${i}`, value: "v" }), ctx);
      if (resp.error?.code === -32004) rateLimited += 1;
    }
    expect(rateLimited).toBeGreaterThan(0);
  });

  test("key validation: empty, too-long, bad chars, reserved prefix are rejected", async () => {
    const bad = [
      "",                                     // empty
      "x".repeat(300),                        // too long
      "has space",                            // regex — space not allowed
      "has@illegal!",                         // regex — @ and ! not allowed
      ".leading-dot",                         // cannot start with .
      "trailing-dot.",                        // cannot end with .
      "/leading-slash",                       // cannot start with /
      "trailing-slash/",                      // cannot end with /
      "__internal",                           // reserved prefix (non-builtin)
      "ezcorp/thing",                         // reserved prefix (non-builtin)
    ];
    for (const key of bad) {
      const resp = await handleStorageRpc(extPolicy, rpc("set", { key, value: 1 }), makeCtx(manifestPolicy));
      expect(resp.error).toBeDefined();
      expect(resp.error!.code).toBe(-32602);
    }
    // Control: a valid key is NOT rejected.
    const okResp = await handleStorageRpc(extPolicy, rpc("set", { key: "good_key.1-2/a:b", value: 1 }), makeCtx(manifestPolicy));
    expect(okResp.error).toBeUndefined();
  });

  test("batch: >100 operations returns -32602", async () => {
    const ops = Array.from({ length: 101 }, (_, i) => ({ action: "set", key: `b-${i}`, value: i }));
    const resp = await handleStorageRpc(extPolicy, rpc("batch", { operations: ops }), makeCtx(manifestPolicy));
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32602);
    expect(resp.error!.message).toMatch(/100/);
  });

  test("batch: empty operations array is rejected", async () => {
    const resp = await handleStorageRpc(extPolicy, rpc("batch", { operations: [] }), makeCtx(manifestPolicy));
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32602);
  });

  test("encryption flag: stored value in the DB is ciphertext, not plaintext", async () => {
    // Dedicated extension so rate-limit state from earlier tests doesn't bite.
    const encExt = uniqueExtId("ext-enc");
    const encManifest = makeManifest(encExt, "1MB");
    await insertExtension(encExt, encManifest);

    const plaintext = "hunter2-super-secret-token";
    const setResp = await handleStorageRpc(
      encExt,
      rpc("set", { key: "api-token", value: plaintext, encrypted: true }),
      makeCtx(encManifest),
    );
    expect(setResp.error).toBeUndefined();

    // Bypass the handler and read the row directly from the DB.
    const rows = await getDb()
      .select()
      .from(extensionStorage)
      .where(
        and(eq(extensionStorage.extensionId, encExt), eq(extensionStorage.key, "api-token")),
      );
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.encrypted).toBe(true);

    // The `value` column must not contain the plaintext anywhere.
    const raw = JSON.stringify(row.value);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain("hunter2");

    // And the handler still round-trips the plaintext back out via decrypt.
    const getResp = await handleStorageRpc(
      encExt,
      rpc("get", { key: "api-token" }),
      makeCtx(encManifest),
    );
    expect(getResp.error).toBeUndefined();
    expect((getResp.result as any).exists).toBe(true);
    expect((getResp.result as any).value).toBe(plaintext);
  });
});
