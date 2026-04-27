import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { upsertSetting } = await import("../db/queries/settings");
const { hasAnyProvider, getQuickstartSteps } = await import("../db/queries/quickstart");

describe("quickstart queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("hasAnyProvider — no settings rows → false", async () => {
    expect(await hasAnyProvider()).toBe(false);
  });

  test("hasAnyProvider — settings exist but none provider:%:apiKey → false", async () => {
    await upsertSetting("provider:defaultTier", "balanced");
    await upsertSetting("provider:preferenceOrder", ["anthropic"]);
    expect(await hasAnyProvider()).toBe(false);
  });

  test("hasAnyProvider — provider:<name>:apiKey present → true", async () => {
    await upsertSetting("provider:anthropic:apiKey", "sk-test");
    expect(await hasAnyProvider()).toBe(true);
  });

  test("hasAnyProvider — provider:oauth:<name> present → true", async () => {
    await upsertSetting("provider:oauth:openai", { token: "x" });
    expect(await hasAnyProvider()).toBe(true);
  });

  test("getQuickstartSteps — fresh user, no provider/chat/agent → those report false", async () => {
    // `extension` is intentionally not asserted here: the first-run boot
    // seeds bundled extensions (e.g. ai-kit beyond builtin-tools), and
    // this test is about the per-user signals (provider/chat/agent),
    // not the global extension fixture state.
    const u = await createUser({ email: "fresh@q.com", passwordHash: "h", name: "Fresh" });
    const steps = await getQuickstartSteps(u.id);
    expect(steps.provider).toBe(false);
    expect(steps.chat).toBe(false);
    expect(steps.agent).toBe(false);
  });

  test("getQuickstartSteps.provider mirrors hasAnyProvider — DRY contract", async () => {
    const u = await createUser({ email: "dry@q.com", passwordHash: "h", name: "Dry" });

    expect((await getQuickstartSteps(u.id)).provider).toBe(false);
    expect(await hasAnyProvider()).toBe(false);

    await upsertSetting("provider:anthropic:apiKey", "sk-x");

    const steps = await getQuickstartSteps(u.id);
    expect(steps.provider).toBe(true);
    expect(await hasAnyProvider()).toBe(true);
    // Both helpers must agree on the same DB state — this locks the DRY
    // refactor that pulled both call sites onto the shared query module.
    expect(steps.provider).toBe(await hasAnyProvider());
  });
});
