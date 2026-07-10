/**
 * V2 END-TO-END pipeline test for the two savings ROUTE handlers.
 *
 * Unlike api-analytics-savings*.server.test.ts (which MOCK the query module),
 * this drives the ACTUAL +server.ts handlers against a REAL migrated PGlite DB
 * with the REAL query module + default pi-ai pricing — proving the whole chain
 * DB rows → query → handler → JSON. It is a `bun:test` file (mirrors
 * seed-reset-route.test.ts) so it can seed the shared test DB via test-pglite;
 * the vitest suites keep the fast, isolated handler-contract coverage.
 *
 * Focus (things the mocked suites can't prove): admin (whole project) vs member
 * (own-slice) return DIFFERENT DB-derived numbers; the per-user route scopes to
 * the caller's own userId; days-clamp changes real results; 404 fail-closed on
 * unknown project; 401/403 gates; and the EXACT response contract on a real
 * DB-derived payload.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  getTestDb,
  closeTestDb,
  mockDbConnection,
  mockRealSettings,
} from "../../../src/__tests__/helpers/test-pglite";

mockDbConnection();
mockRealSettings();

const { getModels } = await import("@earendil-works/pi-ai");
const { users, projects, conversations, messages } = await import("../../../src/db/schema");
const { GET: getUser } = await import("../routes/api/analytics/savings/+server");
const { GET: getProjectRoute } = await import(
  "../routes/api/analytics/savings/project/[id]/+server"
);

const ADMIN = { id: "e2e-admin", email: "admin@e2e", name: "Admin", role: "admin" } as const;
const MEMBER = { id: "e2e-member", email: "member@e2e", name: "Member", role: "member" } as const;
const P = "e2e-proj";
const C_ADMIN = "e2e-c-admin";
const C_MEMBER = "e2e-c-member";

const RECENT = new Date(Date.now() - 60 * 60 * 1000);
const OLD = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

const CONTRACT_KEYS = ["estimated", "perModel", "rangeDays", "stats", "subscriptionProviders"];
const STATS_KEYS = [
  "cacheSavedUsd",
  "cacheReadSavedUsd",
  "cacheWriteSurchargeUsd",
  "write1hPremiumUsd",
  "routingSavedUsd",
  "tokensCachedRead",
  "tokensCacheWritten",
  "cacheHitRate",
  "turnsTotal",
  "turnsRouted",
  "turnsFailover",
];

function userEvent(qs: string, locals: Record<string, unknown>) {
  return { url: new URL(`http://localhost/api/analytics/savings${qs}`), locals } as any;
}
function projectEvent(id: string, qs: string, locals: Record<string, unknown>) {
  return {
    url: new URL(`http://localhost/api/analytics/savings/project/${id}${qs}`),
    params: { id },
    locals,
  } as any;
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();

  const priced = getModels("anthropic").filter(
    (m) => m.cost.input > 0 && m.cost.cacheRead > 0 && m.cost.cacheWrite > 0,
  );
  const MODEL = priced[0]!.id;

  await db.insert(users).values([
    { id: ADMIN.id, email: ADMIN.email, passwordHash: "x", name: ADMIN.name, role: "admin" },
    { id: MEMBER.id, email: MEMBER.email, passwordHash: "x", name: MEMBER.name, role: "member" },
  ] as any);
  await db.insert(projects).values([{ id: P, name: "e2e", path: "/tmp/e2e" }] as any);
  await db.insert(conversations).values([
    { id: C_ADMIN, projectId: P, title: "adm", userId: ADMIN.id },
    { id: C_MEMBER, projectId: P, title: "mem", userId: MEMBER.id },
  ] as any);

  const mk = (id: string, conv: string, usage: unknown, createdAt = RECENT) => ({
    id,
    conversationId: conv,
    role: "assistant",
    content: "x",
    provider: "anthropic",
    model: MODEL,
    usage,
    createdAt,
  });
  await db.insert(messages).values([
    // Admin's two RECENT turns: one with cache reads, one plain.
    mk("e2e-a1", C_ADMIN, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0 }),
    mk("e2e-a2", C_ADMIN, { inputTokens: 200, outputTokens: 50 }),
    // Admin OLD turn (5000 cached-read) — only visible at days=365.
    mk("e2e-a3", C_ADMIN, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5000, cacheWriteTokens: 0 }, OLD),
    // Member's one RECENT turn (300 cached-read).
    mk("e2e-m1", C_MEMBER, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 0 }),
  ] as any);
}, 30_000);

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("GET /api/analytics/savings (per-user, real pipeline)", () => {
  test("scopes to the caller's OWN userId and returns the exact contract on real data", async () => {
    const res = await getUser(userEvent("", { user: ADMIN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual([...CONTRACT_KEYS].sort());
    expect(Object.keys(body.stats).sort()).toEqual([...STATS_KEYS].sort());
    expect(Object.keys(body.perModel[0]).sort()).toEqual(
      ["provider", "model", "turns", "cacheSavedUsd", "routingSavedUsd", "tokensCachedRead", "cacheHitRate", "estimated"].sort(),
    );
    // Admin's own rows only (2 recent turns), 1000 cached-read tokens.
    expect(body.stats.turnsTotal).toBe(2);
    expect(body.stats.tokensCachedRead).toBe(1000);
    expect(body.estimated).toBe(true);
    expect(body.subscriptionProviders).toEqual([]); // anthropic: no oauth creds seeded
    // Real pricing produced finite, positive read savings.
    expect(Number.isFinite(body.stats.cacheReadSavedUsd)).toBe(true);
    expect(body.stats.cacheReadSavedUsd).toBeGreaterThan(0);
  });

  test("member sees ONLY their own rows (different from admin's)", async () => {
    const res = await getUser(userEvent("", { user: MEMBER }));
    const body = (await res.json()) as any;
    expect(body.stats.turnsTotal).toBe(1);
    expect(body.stats.tokensCachedRead).toBe(300);
  });

  test("days=365 pulls in the caller's OLD turn (real range filter)", async () => {
    const body = (await (await getUser(userEvent("?days=365", { user: ADMIN }))).json()) as any;
    expect(body.rangeDays).toBe(365);
    expect(body.stats.turnsTotal).toBe(3);
    expect(body.stats.tokensCachedRead).toBe(6000); // 1000 + 5000
  });

  test("401 unauthenticated; 403 when key scope lacks 'read'", async () => {
    let res = await getUser(userEvent("", {}));
    expect(res.status).toBe(401);
    res = await getUser(userEvent("", { user: ADMIN, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).required).toBe("read");
  });
});

describe("GET /api/analytics/savings/project/[id] (real pipeline)", () => {
  test("admin sees the WHOLE project; member sees ONLY their own slice", async () => {
    const adminBody = (await (await getProjectRoute(projectEvent(P, "", { user: ADMIN }))).json()) as any;
    // Whole project = admin's 2 recent + member's 1 recent = 3 turns.
    expect(adminBody.stats.turnsTotal).toBe(3);
    expect(adminBody.stats.tokensCachedRead).toBe(1300); // 1000 + 300

    const memberBody = (await (await getProjectRoute(projectEvent(P, "", { user: MEMBER }))).json()) as any;
    // Member slice = member's own conversation only.
    expect(memberBody.stats.turnsTotal).toBe(1);
    expect(memberBody.stats.tokensCachedRead).toBe(300);

    // The two views genuinely differ ⇒ scope is enforced end-to-end.
    expect(adminBody.stats.tokensCachedRead).not.toBe(memberBody.stats.tokensCachedRead);
    expect(Object.keys(adminBody).sort()).toEqual([...CONTRACT_KEYS].sort());
  });

  test("days=365 (admin) pulls the OLD admin turn into the project total", async () => {
    const body = (await (await getProjectRoute(projectEvent(P, "?days=365", { user: ADMIN }))).json()) as any;
    expect(body.stats.turnsTotal).toBe(4);
    expect(body.stats.tokensCachedRead).toBe(6300); // 1300 + 5000
  });

  test("unknown project 404s fail-closed", async () => {
    const res = await getProjectRoute(projectEvent("no-such-project", "", { user: MEMBER }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("Not found");
  });

  test("401 unauthenticated; 403 when key scope lacks 'read'", async () => {
    let res = await getProjectRoute(projectEvent(P, "", {}));
    expect(res.status).toBe(401);
    res = await getProjectRoute(projectEvent(P, "", { user: MEMBER, apiKeyScopes: ["chat"] }));
    expect(res.status).toBe(403);
  });

  test("days clamp: 0/junk → 30, 9999 → 365 (observed via real range effect)", async () => {
    // days=9999 clamps to 365 ⇒ includes the OLD admin turn (turnsTotal 4).
    const clamped = (await (await getProjectRoute(projectEvent(P, "?days=9999", { user: ADMIN }))).json()) as any;
    expect(clamped.rangeDays).toBe(365);
    expect(clamped.stats.turnsTotal).toBe(4);
    // days=0 and junk fall back to the 30-day default ⇒ OLD turn excluded (3).
    for (const qs of ["?days=0", "?days=abc"]) {
      const body = (await (await getProjectRoute(projectEvent(P, qs, { user: ADMIN }))).json()) as any;
      expect(body.rangeDays).toBe(30);
      expect(body.stats.turnsTotal).toBe(3);
    }
  });
});
