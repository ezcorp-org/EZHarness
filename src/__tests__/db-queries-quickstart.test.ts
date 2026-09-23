import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { upsertSetting } = await import("../db/queries/settings");
const { hasAnyProvider, hasUsableProvider, anyKeylessProvider, getQuickstartSteps } = await import(
  "../db/queries/quickstart"
);
const { LLM_PROVIDERS } = await import("../runtime/routing/llm-providers");

/** The real provider table with every keyless tier stripped — a world without Kilo's free tier. */
const NO_KEYLESS = LLM_PROVIDERS.map((spec) => ({ ...spec, keylessFreeTier: false }));

describe("quickstart queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("hasAnyProvider — no settings rows → false", async () => {
    expect(await hasAnyProvider()).toBe(false);
  });

  test("hasAnyProvider — settings exist but none provider:apiKey:% → false", async () => {
    await upsertSetting("provider:defaultTier", "balanced");
    await upsertSetting("provider:preferenceOrder", ["anthropic"]);
    expect(await hasAnyProvider()).toBe(false);
  });

  test("hasAnyProvider — provider:apiKey:<name> present → true", async () => {
    await upsertSetting("provider:apiKey:anthropic", "sk-test");
    expect(await hasAnyProvider()).toBe(true);
  });

  test("hasAnyProvider — provider:oauth:<name> present → true", async () => {
    await upsertSetting("provider:oauth:openai", { token: "x" });
    expect(await hasAnyProvider()).toBe(true);
  });

  test("getQuickstartSteps — fresh user can already chat, but has no chat/agent yet", async () => {
    // `extension` is intentionally not asserted here: the first-run boot
    // seeds bundled extensions (e.g. ai-kit beyond builtin-tools), and
    // this test is about the per-user signals (provider/chat/agent),
    // not the global extension fixture state.
    //
    // `provider` is TRUE with nothing configured: the keyless Kilo tier
    // answers anonymously, so a fresh install can send a message. This
    // assertion was `false` before #155 added that tier, when "has a
    // provider" and "can chat" were still the same question.
    const u = await createUser({ email: "fresh@q.com", passwordHash: "h", name: "Fresh" });
    const steps = await getQuickstartSteps(u.id);
    expect(steps.provider).toBe(true);
    expect(steps.chat).toBe(false);
    expect(steps.agent).toBe(false);
  });

  // Replaces the old "provider mirrors hasAnyProvider — DRY contract" test.
  // That contract dates from the initial commit, three months before the
  // keyless tier made "a credential is configured" and "this install can
  // chat" two different facts. The DRY property it protected — one source of
  // truth per question — is kept: the step now reads hasUsableProvider(),
  // and the two helpers are held to the relationship they actually have.
  test("getQuickstartSteps.provider reads hasUsableProvider, not hasAnyProvider", async () => {
    const u = await createUser({ email: "dry@q.com", passwordHash: "h", name: "Dry" });

    // Fresh install: nothing configured, yet chat works. The two answers
    // DIVERGE here — which is the whole point of having two helpers.
    expect(await hasAnyProvider()).toBe(false);
    expect(await hasUsableProvider()).toBe(true);
    expect((await getQuickstartSteps(u.id)).provider).toBe(await hasUsableProvider());

    // A configured credential satisfies both.
    await upsertSetting("provider:apiKey:anthropic", "sk-x");
    expect(await hasAnyProvider()).toBe(true);
    expect((await getQuickstartSteps(u.id)).provider).toBe(true);
  });

  test("usable is a superset of configured — a stored key never reads as unusable", async () => {
    for (const setup of [
      async () => {},
      async () => upsertSetting("provider:apiKey:openai", "sk-y"),
      async () => upsertSetting("provider:oauth:google", { token: "t" }),
    ]) {
      await setupTestDb();
      await setup();
      if (await hasAnyProvider()) {
        expect(await hasUsableProvider()).toBe(true);
        expect(await hasUsableProvider(NO_KEYLESS)).toBe(true);
      }
    }
  });
});

describe("without a keyless tier, 'usable' falls back to 'configured'", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("anyKeylessProvider reads the flag, not a hardcoded provider id", () => {
    expect(anyKeylessProvider(LLM_PROVIDERS)).toBe(LLM_PROVIDERS.some((p) => p.keylessFreeTier));
    expect(anyKeylessProvider(NO_KEYLESS)).toBe(false);
    expect(anyKeylessProvider([])).toBe(false);
  });

  test("a fresh install with no keyless tier cannot chat, so the banner still fires", async () => {
    // This is the case the banner was built for, and it must survive: if the
    // keyless tier is ever removed, the nudge has to come back on its own.
    expect(await hasUsableProvider(NO_KEYLESS)).toBe(false);
    await upsertSetting("provider:apiKey:anthropic", "sk-z");
    expect(await hasUsableProvider(NO_KEYLESS)).toBe(true);
  });
});
