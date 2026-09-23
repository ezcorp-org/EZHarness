/**
 * Secure User-Site Preview / Port Exposure — Phase 1.
 * Preview registry CRUD + access semantics + lifecycle.
 *
 * Critical invariants under test:
 *  - generatePreviewId is opaque (26 Crockford base32 chars) + unique
 *  - createPreviewSession validates kind-specific fields + stamps expiry
 *  - getServablePreview is the requester-only access gate:
 *      wrong user / expired / revoked / inactive all return undefined
 *  - touchPreview only bumps active, owned rows
 *  - revokePreview is owner-scoped + idempotent
 *  - sweepExpiredPreviews flips only past-due active rows
 *  - reapPreviewsForConversation revokes a conversation's active rows
 *  - countActivePreviewsForUser ignores expired/revoked rows
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type {
  SandboxPreviewCloseRequest,
  SandboxPreviewOpenRequest,
} from "../runtime/workspaces/target";
import { sandboxBindingRow } from "./helpers/sandbox-binding-row";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const preview = await import("../db/queries/preview-sessions");
const { getDb } = await import("../db/connection");
const { previewSessions, sandboxBindings } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const { localWorkspaceTarget, sandboxWorkspaceTarget } = await import("../runtime/workspaces/target");

let userA: string;
let userB: string;
let convA: string;
let convA2: string;

// A real project root + `.ezcorp/sites/` tree so the staticPath
// containment guard (assertUnderSitesRoot) can realpath valid paths and
// reject out-of-bounds ones. `PROJECT_ROOT` is passed explicitly so the
// guard never reads the host's cwd/env.
let PROJECT_ROOT: string;
let SITES_ROOT: string;
let VALID_STATIC: string; // a real dir under SITES_ROOT

/** Create a static preview whose staticPath is contained in the sites
 *  root — DRY helper so the lifecycle tests don't each re-derive a path. */
async function mkStatic(over: Partial<Parameters<typeof preview.createPreviewSession>[0]> = {}) {
  return preview.createPreviewSession({
    userId: userA,
    conversationId: convA,
    kind: "static",
    staticPath: VALID_STATIC,
    projectRoot: PROJECT_ROOT,
    workspaceTarget: localWorkspaceTarget(PROJECT_ROOT),
    ...over,
  });
}

beforeAll(async () => {
  await setupTestDb();
  const a = await createUser({ email: "prev-a@test.com", passwordHash: "h", name: "A" });
  const b = await createUser({ email: "prev-b@test.com", passwordHash: "h", name: "B" });
  userA = a.id;
  userB = b.id;
  const proj = await createProject({ name: "P", path: "/tmp/p" });
  const c1 = await createConversation(proj.id, { userId: userA });
  const c2 = await createConversation(proj.id, { userId: userA });
  convA = c1.id;
  convA2 = c2.id;

  PROJECT_ROOT = realpathSync(await mkdtemp(join(tmpdir(), "ezprev-q-")));
  SITES_ROOT = join(PROJECT_ROOT, ".ezcorp", "sites");
  VALID_STATIC = join(SITES_ROOT, "site-a");
  await mkdir(VALID_STATIC, { recursive: true });
  // 30s hook timeout: PGlite setupTestDb() can exceed bun's 5s default under
  // --coverage instrumentation + PARALLEL contention on the CI runner, which
  // otherwise crashes this gated suite to 0% coverage (see scripts/test-coverage.sh).
}, 30_000);

afterAll(async () => {
  await closeTestDb();
  await rm(PROJECT_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("generatePreviewId / isValidPreviewId", () => {
  test("mints a 26-char Crockford base32 id with no ambiguous letters", () => {
    for (let i = 0; i < 200; i++) {
      const id = preview.generatePreviewId();
      expect(id).toHaveLength(26);
      expect(preview.isValidPreviewId(id)).toBe(true);
      // no i, l, o, u (Crockford excludes them)
      expect(/[ilou]/.test(id)).toBe(false);
    }
  });

  test("ids are unique across many draws (no collisions)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(preview.generatePreviewId());
    expect(seen.size).toBe(5000);
  });

  test("rejects malformed ids", () => {
    expect(preview.isValidPreviewId("")).toBe(false);
    expect(preview.isValidPreviewId("short")).toBe(false);
    expect(preview.isValidPreviewId("A".repeat(26))).toBe(false); // uppercase
    expect(preview.isValidPreviewId("i".repeat(26))).toBe(false); // ambiguous letter
    expect(preview.isValidPreviewId("0".repeat(27))).toBe(false); // too long
    expect(preview.isValidPreviewId("ab.cdefghjkmnpqrstvwxyz123")).toBe(false); // dot
  });
});

describe("createPreviewSession", () => {
  test("creates a static preview with a 24h default expiry", async () => {
    const before = Date.now();
    const row = await mkStatic();
    expect(preview.isValidPreviewId(row.id)).toBe(true);
    expect(row.userId).toBe(userA);
    expect(row.conversationId).toBe(convA);
    expect(row.kind).toBe("static");
    expect(row.staticPath).toBe(VALID_STATIC);
    expect(row.targetPort).toBeNull();
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBeGreaterThan(24 * 3600 * 1000 - 1000);
    expect(ttl).toBeLessThan(24 * 3600 * 1000 + 1000);
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("creates a dynamic preview with port + netnsId", async () => {
    const row = await preview.createPreviewSession({
      userId: userA,
      conversationId: convA,
      kind: "dynamic",
      targetPort: 5173,
      netnsId: "ns-abc",
      workspaceTarget: localWorkspaceTarget(PROJECT_ROOT),
    });
    expect(row.kind).toBe("dynamic");
    expect(row.targetPort).toBe(5173);
    expect(row.netnsId).toBe("ns-abc");
    expect(row.staticPath).toBeNull();
  });

  test("rejects missing userId / conversationId", async () => {
    await expect(preview.createPreviewSession({ userId: "", conversationId: convA, kind: "static", staticPath: "/x", workspaceTarget: localWorkspaceTarget(PROJECT_ROOT) })).rejects.toThrow(/userId/);
    await expect(preview.createPreviewSession({ userId: userA, conversationId: "", kind: "static", staticPath: "/x", workspaceTarget: localWorkspaceTarget(PROJECT_ROOT) })).rejects.toThrow(/conversationId/);
  });

  test("rejects static without staticPath and dynamic without a valid port", async () => {
    await expect(preview.createPreviewSession({ userId: userA, conversationId: convA, kind: "static", workspaceTarget: localWorkspaceTarget(PROJECT_ROOT) })).rejects.toThrow(/staticPath/);
    await expect(preview.createPreviewSession({ userId: userA, conversationId: convA, kind: "dynamic", workspaceTarget: localWorkspaceTarget(PROJECT_ROOT) })).rejects.toThrow(/targetPort/);
    await expect(preview.createPreviewSession({ userId: userA, conversationId: convA, kind: "dynamic", targetPort: 0, workspaceTarget: localWorkspaceTarget(PROJECT_ROOT) })).rejects.toThrow(/targetPort/);
  });

  test("rejects a staticPath OUTSIDE the sites root (trust boundary)", async () => {
    // Absolute escape: /etc is nowhere near .ezcorp/sites.
    await expect(
      mkStatic({ staticPath: "/etc" }),
    ).rejects.toThrow(/must resolve under|fail-closed/);
    // A path that points into .ezcorp/data is the exact hole we close.
    await expect(
      mkStatic({ staticPath: join(PROJECT_ROOT, ".ezcorp", "data") }),
    ).rejects.toThrow(/must resolve under|fail-closed/);
  });

  test("rejects a non-existent staticPath (fail-closed)", async () => {
    await expect(
      mkStatic({ staticPath: join(SITES_ROOT, "does-not-exist") }),
    ).rejects.toThrow(/fail-closed/);
  });

  test("accepts a valid `.ezcorp/sites/<dir>` staticPath", async () => {
    const row = await mkStatic();
    expect(row.staticPath).toBe(VALID_STATIC);
    expect(row.status).toBe("active");
  });

  test("dynamic previews skip the staticPath containment check", async () => {
    // Dynamic rows have no staticPath, so the guard must not run / throw.
    const row = await preview.createPreviewSession({
      userId: userA,
      conversationId: convA,
      kind: "dynamic",
      targetPort: 4321,
      projectRoot: "/nonexistent-root-should-be-ignored",
      workspaceTarget: localWorkspaceTarget(PROJECT_ROOT),
    });
    expect(row.kind).toBe("dynamic");
  });

  test("sandbox open and close keep the complete binding and deny a forged generation", async () => {
    const calls: Array<{ kind: string; request: Record<string, unknown> }> = [];
    const binding = {
      projectId: "sandbox-project",
      workspaceId: "sandbox-workspace",
      connectionId: "sandbox-connection",
      providerId: "incus",
      generation: 11,
      presetId: "isolated-feature",
      releaseDigest: "a".repeat(64),
      presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64),
    };
    const backend = {
      async execute() { return { content: [{ type: "text" as const, text: "unused" }], details: {} }; },
      previews: {
        async open(request: SandboxPreviewOpenRequest) {
          calls.push({ kind: "open", request: request as unknown as Record<string, unknown> });
        },
        async serve() { return new Response("sandbox"); },
        async close(request: SandboxPreviewCloseRequest) {
          calls.push({ kind: "close", request: request as unknown as Record<string, unknown> });
        },
      },
    };
    const target = sandboxWorkspaceTarget(binding, backend);
    const row = await preview.createPreviewSession({
      userId: userA,
      conversationId: convA,
      kind: "dynamic",
      targetPort: 4173,
      workspaceTarget: target,
      ttlMs: 60_000,
    });
    expect(row.workspaceTarget).toEqual({ kind: "sandbox", binding });
    expect(calls[0]).toMatchObject({
      kind: "open",
      request: { binding, previewId: row.id, userId: userA, conversationId: convA, targetPort: 4173 },
    });
    await expect(preview.reapPreviewIdsForConversation(convA))
      .rejects.toThrow("Local workspace fallback was denied");

    const forged = sandboxWorkspaceTarget({ ...binding, generation: 12 }, backend);
    await expect(preview.revokePreview(row.id, userA, new Date(), forged))
      .rejects.toThrow("Local workspace fallback was denied");
    expect(calls).toHaveLength(1);
    expect((await preview.getPreviewByIdRaw(row.id))?.status).toBe("active");

    await preview.revokePreview(row.id, userA, new Date(), target);
    expect(calls[1]).toMatchObject({
      kind: "close",
      request: { binding, previewId: row.id, userId: userA, targetPort: 4173 },
    });
    expect((await preview.getPreviewByIdRaw(row.id))?.status).toBe("revoked");
  });

  test("sandbox open without a preview capability fails before a registry row is created", async () => {
    const before = await preview.listPreviewsForUser(userA);
    const target = sandboxWorkspaceTarget({
      projectId: "sandbox-project",
      workspaceId: "sandbox-workspace",
      connectionId: "sandbox-connection",
      providerId: "incus",
      generation: 12,
      presetId: "isolated-feature",
      releaseDigest: "a".repeat(64),
      presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64),
    }, {
      async execute() { return { content: [{ type: "text" as const, text: "unused" }], details: {} }; },
    });
    await expect(preview.createPreviewSession({
      userId: userA,
      conversationId: convA,
      kind: "dynamic",
      targetPort: 4173,
      workspaceTarget: target,
    })).rejects.toThrow("Local workspace fallback was denied");
    expect(await preview.listPreviewsForUser(userA)).toHaveLength(before.length);
  });

  test("sandbox static preview stores no AMD path and opens through its capability", async () => {
    const opened: SandboxPreviewOpenRequest[] = [];
    const binding = {
      projectId: "static-project", workspaceId: "static-workspace",
      connectionId: "static-connection", providerId: "incus", generation: 1,
      presetId: "isolated-feature", releaseDigest: "a".repeat(64),
      presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64),
    };
    const target = sandboxWorkspaceTarget(binding, {
      async execute() { return { content: [], details: {} }; },
      previews: {
        async open(request: SandboxPreviewOpenRequest) { opened.push(request); },
        async serve() { return new Response("sandbox static"); },
        async close() {},
      },
    });
    await expect(preview.createPreviewSession({
      userId: userA, conversationId: convA, kind: "static",
      staticPath: VALID_STATIC, workspaceTarget: target,
    })).rejects.toThrow("cannot register an AMD host path");

    const row = await preview.createPreviewSession({
      userId: userA, conversationId: convA, kind: "static", workspaceTarget: target,
    });
    expect(row.staticPath).toBeNull();
    expect(row.workspaceTarget).toEqual({ kind: "sandbox", binding });
    expect(opened).toMatchObject([{ binding, previewId: row.id, targetPort: null }]);
    await preview.revokePreview(row.id, userA, new Date(), target);
  });
});

describe("assertUnderSitesRoot / previewSitesRoot (unit)", () => {
  test("previewSitesRoot derives `<root>/.ezcorp/sites`", () => {
    expect(preview.previewSitesRoot(PROJECT_ROOT)).toBe(SITES_ROOT);
  });

  test("accepts a contained dir, rejects an escape + a missing path", () => {
    expect(() => preview.assertUnderSitesRoot(VALID_STATIC, PROJECT_ROOT)).not.toThrow();
    expect(() => preview.assertUnderSitesRoot("/etc", PROJECT_ROOT)).toThrow(/must resolve under/);
    expect(() => preview.assertUnderSitesRoot(join(SITES_ROOT, "missing"), PROJECT_ROOT)).toThrow(/fail-closed/);
  });

  test("fails closed when the sites root itself does not exist", () => {
    expect(() => preview.assertUnderSitesRoot(VALID_STATIC, "/no/such/project/root")).toThrow(/fail-closed/);
  });
});

describe("getServablePreview (requester-only access gate)", () => {
  test("returns the row for the owner when active + unexpired", async () => {
    const row = await mkStatic();
    const got = await preview.getServablePreview(row.id, userA);
    expect(got?.id).toBe(row.id);
  });

  test("returns undefined for a different user (wrong-user)", async () => {
    const row = await mkStatic();
    expect(await preview.getServablePreview(row.id, userB)).toBeUndefined();
  });

  test("returns undefined for a missing id and a malformed id", async () => {
    expect(await preview.getServablePreview(preview.generatePreviewId(), userA)).toBeUndefined();
    expect(await preview.getServablePreview("not-a-valid-id", userA)).toBeUndefined();
  });

  test("returns undefined once expired", async () => {
    const row = await mkStatic();
    // Force expiry into the past.
    await getDb().update(previewSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(previewSessions.id, row.id));
    expect(await preview.getServablePreview(row.id, userA)).toBeUndefined();
  });

  test("returns undefined once revoked", async () => {
    const row = await mkStatic();
    await preview.revokePreview(row.id, userA);
    expect(await preview.getServablePreview(row.id, userA)).toBeUndefined();
  });

  test("stops serving a local preview after its project receives a sandbox binding", async () => {
    const project = await createProject({ name: "Preview transition", path: PROJECT_ROOT });
    const conversation = await createConversation(project.id, { userId: userA });
    const row = await mkStatic({ conversationId: conversation.id });
    expect((await preview.getServablePreview(row.id, userA))?.id).toBe(row.id);

    await getDb().insert(sandboxBindings).values(sandboxBindingRow(project.id));
    expect(await preview.getServablePreview(row.id, userA)).toBeUndefined();
  });
});

describe("touchPreview", () => {
  test("bumps lastSeenAt for an active owned row", async () => {
    const row = await mkStatic();
    expect(row.lastSeenAt).toBeNull();
    const updated = await preview.touchPreview(row.id, userA);
    expect(updated?.lastSeenAt).not.toBeNull();
  });

  test("no-op for wrong user or revoked row", async () => {
    const row = await mkStatic();
    expect(await preview.touchPreview(row.id, userB)).toBeUndefined();
    await preview.revokePreview(row.id, userA);
    expect(await preview.touchPreview(row.id, userA)).toBeUndefined();
  });
});

describe("revokePreview", () => {
  test("is owner-scoped and idempotent", async () => {
    const row = await mkStatic();
    expect(await preview.revokePreview(row.id, userB)).toBeUndefined(); // wrong user
    const r1 = await preview.revokePreview(row.id, userA);
    expect(r1?.status).toBe("revoked");
    expect(r1?.revokedAt).not.toBeNull();
    const r2 = await preview.revokePreview(row.id, userA); // idempotent
    expect(r2?.revokedAt?.getTime()).toBe(r1?.revokedAt?.getTime());
  });

  test("returns undefined for a missing id", async () => {
    expect(await preview.revokePreview(preview.generatePreviewId(), userA)).toBeUndefined();
  });
});

describe("sweepExpiredPreviews", () => {
  test("flips only past-due active rows to expired", async () => {
    const stale = await mkStatic({ userId: userB });
    const fresh = await mkStatic({ userId: userB });
    await getDb().update(previewSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(previewSessions.id, stale.id));
    const n = await preview.sweepExpiredPreviews();
    expect(n).toBeGreaterThanOrEqual(1);
    const staleRow = await preview.getPreviewByIdRaw(stale.id);
    const freshRow = await preview.getPreviewByIdRaw(fresh.id);
    expect(staleRow?.status).toBe("expired");
    expect(freshRow?.status).toBe("active");
    // second sweep is a no-op for already-expired rows
    const n2 = await preview.sweepExpiredPreviews();
    expect(n2).toBe(0);
  });
});

describe("reapPreviewsForConversation", () => {
  test("revokes only active rows for the given conversation", async () => {
    const a = await mkStatic({ conversationId: convA2 });
    const b = await mkStatic({ conversationId: convA2 });
    const other = await mkStatic({ conversationId: convA });
    const n = await preview.reapPreviewsForConversation(convA2);
    expect(n).toBe(2);
    expect((await preview.getPreviewByIdRaw(a.id))?.status).toBe("revoked");
    expect((await preview.getPreviewByIdRaw(b.id))?.status).toBe("revoked");
    expect((await preview.getPreviewByIdRaw(other.id))?.status).toBe("active");
    expect(await preview.reapPreviewsForConversation("")).toBe(0);
  });
});

describe("countActivePreviewsForUser", () => {
  test("counts only active, unexpired rows", async () => {
    const u = (await createUser({ email: "prev-count@test.com", passwordHash: "h", name: "C" })).id;
    expect(await preview.countActivePreviewsForUser(u)).toBe(0);
    const live = await mkStatic({ userId: u });
    const exp = await mkStatic({ userId: u });
    await getDb().update(previewSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(previewSessions.id, exp.id));
    expect(await preview.countActivePreviewsForUser(u)).toBe(1);
    await preview.revokePreview(live.id, u);
    expect(await preview.countActivePreviewsForUser(u)).toBe(0);
    expect(await preview.countActivePreviewsForUser("")).toBe(0);
  });
});

describe("listPreviewsForUser (management query — v1 floor)", () => {
  test("returns the user's rows newest-first, INCLUDING revoked + expired, scoped to the owner", async () => {
    const owner = (await createUser({ email: "prev-list@test.com", passwordHash: "h", name: "L" })).id;
    const other = (await createUser({ email: "prev-list-other@test.com", passwordHash: "h", name: "O" })).id;

    // Three rows for `owner`, created in order so createdAt desc is testable.
    const first = await mkStatic({ userId: owner });
    await new Promise((r) => setTimeout(r, 5));
    const second = await mkStatic({ userId: owner });
    await new Promise((r) => setTimeout(r, 5));
    const third = await mkStatic({ userId: owner });
    // One for a DIFFERENT user — must NOT appear.
    await mkStatic({ userId: other });

    // Revoke one, expire another — both must still be listed.
    await preview.revokePreview(second.id, owner);
    await getDb().update(previewSessions).set({ status: "expired", expiresAt: new Date(Date.now() - 1000) }).where(eq(previewSessions.id, first.id));

    const list = await preview.listPreviewsForUser(owner);
    expect(list).toHaveLength(3);
    // Only this owner's rows.
    expect(list.every((r) => r.userId === owner)).toBe(true);
    // Newest-first by createdAt.
    expect(list.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
    // Revoked + expired are INCLUDED (full-state management view).
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(second.id)?.status).toBe("revoked");
    expect(byId.get(first.id)?.status).toBe("expired");
  });

  test("returns [] for an empty userId", async () => {
    expect(await preview.listPreviewsForUser("")).toEqual([]);
  });
});

describe("getPreviewByIdRaw (malformed-id early return)", () => {
  test("returns undefined for a malformed id and an empty id (no DB hit)", async () => {
    expect(await preview.getPreviewByIdRaw("bad")).toBeUndefined();
    expect(await preview.getPreviewByIdRaw("")).toBeUndefined();
  });

  test("returns the row for a well-formed, existing id", async () => {
    const row = await mkStatic();
    expect((await preview.getPreviewByIdRaw(row.id))?.id).toBe(row.id);
  });
});
