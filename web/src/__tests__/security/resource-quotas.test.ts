import { test, expect, mock, beforeEach } from "bun:test";
import { checkTokenBudget, recordTokenUsage, checkStorageQuota } from "../../lib/server/security/resource-quotas";

const mockSettings: Record<string, unknown> = {};

mock.module("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings[key],
  upsertSetting: async (key: string, value: unknown) => {
    mockSettings[key] = value;
  },
}));

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

test("checkTokenBudget allows when under limit", async () => {
  const result = await checkTokenBudget("user1");
  expect(result.allowed).toBe(true);
});

test("checkTokenBudget denies when over limit", async () => {
  const today = new Date().toISOString().split("T")[0];
  mockSettings[`usage:tokens:user1:${today}`] = 200_000;
  const result = await checkTokenBudget("user1");
  expect(result.allowed).toBe(false);
  expect(result.resetsAt).toBeDefined();
});

test("checkTokenBudget respects custom limit setting", async () => {
  const today = new Date().toISOString().split("T")[0];
  mockSettings[`usage:tokens:user1:${today}`] = 50;
  mockSettings["limits:dailyTokens"] = 100;
  const result = await checkTokenBudget("user1");
  expect(result.allowed).toBe(true);
});

test("recordTokenUsage increments daily counter", async () => {
  await recordTokenUsage("user1", 500);
  const today = new Date().toISOString().split("T")[0];
  expect(mockSettings[`usage:tokens:user1:${today}`]).toBe(500);

  await recordTokenUsage("user1", 300);
  expect(mockSettings[`usage:tokens:user1:${today}`]).toBe(800);
});

test("checkStorageQuota allows when under limit", async () => {
  const result = await checkStorageQuota("user1", "Conversations", 10);
  expect(result.allowed).toBe(true);
});

test("checkStorageQuota denies when over limit", async () => {
  const result = await checkStorageQuota("user1", "Conversations", 501);
  expect(result.allowed).toBe(false);
});

test("checkStorageQuota respects custom limit", async () => {
  mockSettings["limits:maxConversations"] = 50;
  const result = await checkStorageQuota("user1", "Conversations", 49);
  expect(result.allowed).toBe(true);
  const result2 = await checkStorageQuota("user1", "Conversations", 51);
  expect(result2.allowed).toBe(false);
});

// ── boundary + recovery ─────────────────────────────────────────────────────
// The tests above prove the limit blocks SOMEWHERE between "well under" and
// "well over". That is not the property a quota has to hold: it has to flip at
// exactly the documented count, and it has to un-block when the window rolls.
// These pin both edges so an off-by-one in the comparison operator (`<` vs
// `<=`) cannot pass, and so a broken date key can't silently make the daily
// budget permanent.

test("checkTokenBudget blocks at EXACTLY the limit, not one over", async () => {
  const today = new Date().toISOString().split("T")[0];
  mockSettings["limits:dailyTokens"] = 1000;

  // One under the limit — still allowed, and no reset hint is emitted.
  mockSettings[`usage:tokens:user1:${today}`] = 999;
  const under = await checkTokenBudget("user1");
  expect(under.allowed).toBe(true);
  expect(under.resetsAt).toBeUndefined();

  // Exactly AT the limit — the budget is spent, so this must be DENIED.
  // `used < limit` is the contract; a `<=` regression would allow it.
  mockSettings[`usage:tokens:user1:${today}`] = 1000;
  const at = await checkTokenBudget("user1");
  expect(at.allowed).toBe(false);
  expect(at.resetsAt).toBeDefined();
});

test("recorded usage that reaches the limit actually blocks the next check", async () => {
  // End-to-end through the real record→check seam: the earlier tests seed the
  // counter directly, which proves the comparison but NOT that what
  // recordTokenUsage writes is what checkTokenBudget reads.
  mockSettings["limits:dailyTokens"] = 1000;
  expect((await checkTokenBudget("user1")).allowed).toBe(true);

  await recordTokenUsage("user1", 600);
  expect((await checkTokenBudget("user1")).allowed).toBe(true);

  // Crossing the limit through the public API must flip the gate to blocked.
  await recordTokenUsage("user1", 400);
  const blocked = await checkTokenBudget("user1");
  expect(blocked.allowed).toBe(false);

  // resetsAt must be a real future instant at UTC midnight — a caller shows
  // this to the user, and a NaN/past value would render as "try again never".
  const resetsAt = new Date(blocked.resetsAt as string);
  expect(Number.isNaN(resetsAt.getTime())).toBe(false);
  expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
  expect(blocked.resetsAt as string).toEndWith("T00:00:00.000Z");
});

test("the daily budget RECOVERS: yesterday's exhausted counter does not block today", async () => {
  // The budget is keyed by UTC date. Exhaust YESTERDAY's key well past the
  // limit; today's check must be unaffected. If the date were ever dropped
  // from the key, a user who hit their cap once would be blocked forever.
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
  mockSettings["limits:dailyTokens"] = 1000;
  mockSettings[`usage:tokens:user1:${yesterday}`] = 999_999;

  const result = await checkTokenBudget("user1");
  expect(result.allowed).toBe(true);
  expect(result.resetsAt).toBeUndefined();

  // Pin the key SHAPE, not just the outcome above: the read and the write must
  // both be scoped to today's UTC date. Asserting only "yesterday doesn't
  // block" passes even if the date were dropped from the key entirely (the
  // seeded yesterday-key would then simply never be read) — so assert today's
  // usage lands under a date-stamped key and yesterday's row is left alone.
  await recordTokenUsage("user1", 25);
  expect(mockSettings[`usage:tokens:user1:${today}`]).toBe(25);
  expect(mockSettings[`usage:tokens:user1`]).toBeUndefined();
  expect(mockSettings[`usage:tokens:user1:${yesterday}`]).toBe(999_999);
});

test("checkStorageQuota blocks at EXACTLY limit+1, and one user's usage never blocks another", async () => {
  // Default maxConversations is 500 and the contract is `currentCount <= limit`
  // — so 500 is the last allowed value and 501 is the first blocked one.
  expect((await checkStorageQuota("user1", "Conversations", 500)).allowed).toBe(true);
  expect((await checkStorageQuota("user1", "Conversations", 501)).allowed).toBe(false);

  // Quota is a pure function of the caller-supplied count, so an over-quota
  // user must not leak into another user's decision.
  expect((await checkStorageQuota("user2", "Conversations", 1)).allowed).toBe(true);

  // Each resource reads its OWN limit key. Tightening memories to 5 must
  // block a 6th memory while leaving the conversations limit (default 500)
  // untouched — a shared/mis-keyed lookup would leak one into the other.
  mockSettings["limits:maxMemories"] = 5;
  expect((await checkStorageQuota("user1", "Memories", 5)).allowed).toBe(true);
  expect((await checkStorageQuota("user1", "Memories", 6)).allowed).toBe(false);
  expect((await checkStorageQuota("user1", "Conversations", 400)).allowed).toBe(true);
});
