/**
 * Integration test — onboarding skip path.
 *
 * Asserts the contract that the user-facing skip flow depends on:
 *   1. A user can be marked onboarded WITHOUT any provider configured.
 *   2. After marking, hasAnyProvider() still reports false (skip didn't
 *      sneak in a provider).
 *   3. The combined state — user.onboardedAt set + hasAnyProvider false —
 *      is what the chat banner relies on to keep nagging.
 *
 * Real PGlite, no mocks, exercises the actual SQL.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser, getUserById, markUserOnboarded } = await import("../db/queries/users");
const { hasAnyProvider } = await import("../db/queries/quickstart");
const { upsertSetting } = await import("../db/queries/settings");

describe("onboarding skip flow — markUserOnboarded + hasAnyProvider integration", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("user skips provider step → onboardedAt set, hasAnyProvider stays false", async () => {
    const u = await createUser({ email: "skipper@test.com", passwordHash: "h", name: "Skipper" });
    expect(u.onboardedAt).toBeNull();
    expect(await hasAnyProvider()).toBe(false);

    await markUserOnboarded(u.id);

    const after = (await getUserById(u.id))!;
    expect(after.onboardedAt).toBeInstanceOf(Date);
    // The skip path must not have written any provider rows under the hood.
    expect(await hasAnyProvider()).toBe(false);
  });

  test("user finishes happy-path → onboardedAt set, hasAnyProvider true", async () => {
    const u = await createUser({ email: "finisher@test.com", passwordHash: "h", name: "Finisher" });
    await upsertSetting("provider:apiKey:anthropic", "sk-test");
    await markUserOnboarded(u.id);

    const after = (await getUserById(u.id))!;
    expect(after.onboardedAt).toBeInstanceOf(Date);
    expect(await hasAnyProvider()).toBe(true);
  });

  test("re-marking onboarded user is first-write-wins — second POST is a safe no-op", async () => {
    // Two-tab race: both finish the wizard, both POST /api/onboarding/complete.
    // The endpoint must not 500, must not advance the original stamp.
    const u = await createUser({ email: "idemp@test.com", passwordHash: "h", name: "Idemp" });
    await markUserOnboarded(u.id);
    const first = (await getUserById(u.id))!.onboardedAt!;
    await new Promise((r) => setTimeout(r, 10));
    const secondOk = await markUserOnboarded(u.id);
    expect(secondOk).toBe(false);
    const second = (await getUserById(u.id))!.onboardedAt!;
    expect(second.getTime()).toBe(first.getTime());
  });
});
