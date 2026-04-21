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
