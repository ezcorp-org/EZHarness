/**
 * Tests for the TEST-ONLY seed/reset routes against a real migrated PGlite
 * DB: gating, auth scope, deterministic project+conversation creation, rate
 * limit override, and ownership-checked reset.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";
import { mockDbConnection, mockRealSettings, setupTestDb, closeTestDb } from "../../../src/__tests__/helpers/test-pglite";

mockDbConnection();
mockRealSettings();

const { POST: seed } = await import("../routes/api/__test/seed/+server");
const { POST: reset } = await import("../routes/api/__test/reset/+server");
const { getConversation, createConversation } = await import("../../../src/db/queries/conversations");
const { createProject } = await import("../../../src/db/queries/projects");
const { getSetting } = await import("../../../src/db/queries/settings");
const { createUser } = await import("../../../src/db/queries/users");

const savedE2E = process.env.PI_E2E_REAL;
const savedNodeEnv = process.env.NODE_ENV;
const user = { id: "u1", email: "a@b", name: "A", role: "member" } as const;

function req(body: unknown): Request {
  return new Request("http://127.0.0.1/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const ev = (body: unknown, locals: unknown = { user }) => ({ request: req(body), locals } as any);

beforeAll(async () => {
  await setupTestDb();
  // conversations.user_id is an FK → users.id; create the principals first.
  for (const id of ["u1", "other-user"]) {
    await createUser({ id, email: `${id}@x.test`, passwordHash: "x", name: id, role: "member", status: "active" });
  }
});
afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });
beforeEach(() => { process.env.PI_E2E_REAL = "1"; delete process.env.NODE_ENV; });
afterEach(() => {
  if (savedE2E === undefined) delete process.env.PI_E2E_REAL; else process.env.PI_E2E_REAL = savedE2E;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
});

describe("POST /api/__test/seed", () => {
  test("404 when surface off", async () => {
    delete process.env.PI_E2E_REAL;
    expect((await seed(ev({}))).status).toBe(404);
  });

  test("creates a project + conversation owned by the caller", async () => {
    const res = await seed(ev({ title: "spec-1" }));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.projectId).toBeTruthy();
    expect(out.conversationId).toBeTruthy();
    const conv = await getConversation(out.conversationId);
    expect(conv?.userId).toBe("u1");
    expect(conv?.title).toBe("spec-1");
  });

  test("rateLimitPerMin writes the limits:rateLimit override", async () => {
    const res = await seed(ev({ rateLimitPerMin: 9999 }));
    expect((await res.json()).rateLimitPerMin).toBe(9999);
    const limits = (await getSetting("limits:rateLimit")) as Record<string, number>;
    expect(limits.chat).toBe(9999);
    expect(limits.conversationCreate).toBe(9999);
  });
});

describe("POST /api/__test/reset", () => {
  test("404 when surface off", async () => {
    delete process.env.PI_E2E_REAL;
    expect((await reset(ev({ conversationId: "x" }))).status).toBe(404);
  });

  test("400 on missing conversationId", async () => {
    expect((await reset(ev({}))).status).toBe(400);
  });

  test("deletes a conversation the caller owns", async () => {
    const p = await createProject({ name: "p-reset", path: "/tmp/p-reset" });
    const c = await createConversation(p.id, { title: "doomed", userId: "u1" });
    const res = await reset(ev({ conversationId: c.id }));
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(await getConversation(c.id)).toBeNull();
  });

  test("already-deleted conversation → idempotent no-op", async () => {
    expect(await (await reset(ev({ conversationId: "does-not-exist" }))).json()).toEqual({ ok: true, deleted: false });
  });

  test("403 when resetting another user's conversation as non-admin", async () => {
    const p = await createProject({ name: "p-own", path: "/tmp/p-own" });
    const c = await createConversation(p.id, { title: "theirs", userId: "other-user" });
    const res = await reset(ev({ conversationId: c.id }, { user }));
    expect(res.status).toBe(403);
    // untouched
    expect(await getConversation(c.id)).not.toBeNull();
  });
});
