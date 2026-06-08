/**
 * Secure User-Site Preview / Port Exposure — Phase 2.
 * Requester-scoped expose-consent + per-conversation "always expose"
 * preference (§3.3 + D3).
 *
 * Invariants under test:
 *  - buildConsentCardPayload: pure card copy + stable affordance ids
 *  - exposeDetectedPort: creates a dynamic preview_sessions row owned by
 *    the requester + mints a one-time code (the SINGLE expose path)
 *  - always-expose preference: set/clear/honored, scoped per (conv,user);
 *    a flag stored by a different user does NOT count (fail closed)
 *  - decideOnDetection: pref set → auto-exposed; pref unset → consent-card;
 *    missing ids → skipped
 *  - Ignore is a non-action: nothing is exposed (no row) — verified by the
 *    absence of an expose call in the consent-card branch
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { previewSessions, settings } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const { redeemOneTimeCode, _resetCodeStoreForTests } = await import("../runtime/preview/preview-token");
const consent = await import("../runtime/preview/preview-consent");

let userA: string;
let userB: string;
let convA: string;

beforeAll(async () => {
  await setupTestDb();
  const a = await createUser({ email: "consent-a@test.com", passwordHash: "h", name: "A" });
  const b = await createUser({ email: "consent-b@test.com", passwordHash: "h", name: "B" });
  userA = a.id;
  userB = b.id;
  const proj = await createProject({ name: "P", path: "/tmp/p-consent" });
  const c = await createConversation(proj.id, { userId: userA });
  convA = c.id;
  // 30s hook timeout: PGlite setupTestDb() can exceed bun's 5s default under
  // --coverage instrumentation + PARALLEL contention on the CI runner, which
  // otherwise crashes this gated suite to 0% coverage (see scripts/test-coverage.sh).
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  _resetCodeStoreForTests();
  // Clean preview rows + preview settings between tests.
  await getDb().delete(previewSessions);
  await consent.clearAlwaysExpose(convA);
});

describe("buildConsentCardPayload (pure)", () => {
  test("produces card copy + stable affordance ids", () => {
    const card = consent.buildConsentCardPayload(convA, 5173);
    expect(card.conversationId).toBe(convA);
    expect(card.port).toBe(5173);
    expect(card.title).toContain("5173");
    expect(card.actions).toEqual({
      expose: "expose",
      ignore: "ignore",
      alwaysExpose: "always-expose",
    });
  });
});

describe("exposeDetectedPort", () => {
  test("creates a dynamic preview row owned by the requester + mints a redeemable code", async () => {
    const out = await consent.exposeDetectedPort({ userId: userA, conversationId: convA, port: 5173 });
    expect(out.previewId).toHaveLength(26);
    expect(out.subdomainLabel).toBe(out.previewId);

    const rows = await getDb().select().from(previewSessions).where(eq(previewSessions.id, out.previewId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userA);
    expect(rows[0]!.conversationId).toBe(convA);
    expect(rows[0]!.kind).toBe("dynamic");
    expect(rows[0]!.targetPort).toBe(5173);

    // The code redeems to the same {previewId, userId} (single-use handoff).
    const claims = redeemOneTimeCode(out.code);
    expect(claims).toEqual({ previewId: out.previewId, userId: userA });
  });

  test("rejects an invalid port", async () => {
    await expect(
      consent.exposeDetectedPort({ userId: userA, conversationId: convA, port: 0 }),
    ).rejects.toThrow(/invalid port/);
  });

  test("rejects missing userId / conversationId", async () => {
    await expect(
      consent.exposeDetectedPort({ userId: "", conversationId: convA, port: 5173 }),
    ).rejects.toThrow(/userId/);
    await expect(
      consent.exposeDetectedPort({ userId: userA, conversationId: "", port: 5173 }),
    ).rejects.toThrow(/conversationId/);
  });
});

describe("always-expose preference (D3)", () => {
  test("set → isAlwaysExpose true for the owner only; clear → false", async () => {
    expect(await consent.isAlwaysExpose(convA, userA)).toBe(false);
    await consent.setAlwaysExpose(convA, userA);
    expect(await consent.isAlwaysExpose(convA, userA)).toBe(true);
    // A DIFFERENT user does NOT inherit the flag (requester-scoped).
    expect(await consent.isAlwaysExpose(convA, userB)).toBe(false);
    await consent.clearAlwaysExpose(convA);
    expect(await consent.isAlwaysExpose(convA, userA)).toBe(false);
  });

  test("stores under the documented settings key", async () => {
    await consent.setAlwaysExpose(convA, userA);
    const key = consent.alwaysExposeSettingKey(convA);
    expect(key).toBe(`preview:always-expose:${convA}`);
    const rows = await getDb().select().from(settings).where(eq(settings.key, key));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.value as { userId: string; enabled: boolean })).toEqual({
      userId: userA,
      enabled: true,
    });
  });

  test("empty ids are no-ops / false", async () => {
    await consent.setAlwaysExpose("", userA);
    await consent.setAlwaysExpose(convA, "");
    expect(await consent.isAlwaysExpose("", userA)).toBe(false);
    expect(await consent.isAlwaysExpose(convA, "")).toBe(false);
  });
});

describe("decideOnDetection routing", () => {
  test("pref UNSET → consent-card (Ignore is the implicit non-action: no row created)", async () => {
    const decision = await consent.decideOnDetection({ userId: userA, conversationId: convA, port: 5173 });
    expect(decision.kind).toBe("consent-card");
    if (decision.kind !== "consent-card") throw new Error("unreachable");
    expect(decision.port).toBe(5173);
    expect(decision.card.title).toContain("5173");
    // Nothing was exposed — auto-detect ≠ auto-serve.
    const rows = await getDb().select().from(previewSessions);
    expect(rows).toHaveLength(0);
  });

  test("pref SET → auto-exposed (row + code), no card", async () => {
    await consent.setAlwaysExpose(convA, userA);
    const decision = await consent.decideOnDetection({ userId: userA, conversationId: convA, port: 5173 });
    expect(decision.kind).toBe("auto-exposed");
    if (decision.kind !== "auto-exposed") throw new Error("unreachable");
    expect(decision.port).toBe(5173);

    const rows = await getDb().select().from(previewSessions).where(eq(previewSessions.id, decision.previewId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userA);
    expect(rows[0]!.kind).toBe("dynamic");
    // The handoff code redeems for the owner.
    expect(redeemOneTimeCode(decision.code)).toEqual({ previewId: decision.previewId, userId: userA });
  });

  test("pref set by a DIFFERENT user does not auto-expose (falls back to card)", async () => {
    await consent.setAlwaysExpose(convA, userB); // someone else opted in
    const decision = await consent.decideOnDetection({ userId: userA, conversationId: convA, port: 5173 });
    expect(decision.kind).toBe("consent-card");
  });

  test("missing ids → skipped", async () => {
    const d1 = await consent.decideOnDetection({ userId: "", conversationId: convA, port: 5173 });
    expect(d1.kind).toBe("skipped");
    const d2 = await consent.decideOnDetection({ userId: userA, conversationId: "", port: 5173 });
    expect(d2.kind).toBe("skipped");
  });
});
