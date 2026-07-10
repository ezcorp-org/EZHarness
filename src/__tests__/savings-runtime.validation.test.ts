/**
 * V3 RUNTIME-INTEGRATION validation for the savings-analytics feature.
 *
 * This is the seam nobody else tests: the WHOLE chain
 *
 *     executor.streamChat (real loop)
 *       → subscribe-bridge (real usage → messages.usage persistence)
 *         → savings-analytics query (real aggregation)
 *
 * driven end-to-end. Unlike savings-analytics.test.ts (which SEEDS
 * messages.usage rows directly) and subscribe-bridge-cache-stats.test.ts
 * (which drives subscribe-bridge with a mocked createMessage), this test
 * drives the ACTUAL `AgentExecutor.streamChat` retry/routing loop against a
 * real PGlite DB with only the pi-ai / pi-agent-core / router / credentials
 * boundary mocked (the exact pattern of executor-failover.integration.test.ts).
 * It then queries the `messages` table itself as the SOURCE OF TRUTH and
 * asserts the savings queries report exactly what the runtime persisted.
 *
 * The mock pi-agent-core Agent replays a per-call SCRIPT of turns (text /
 * tool-loop / synthetic usage incl. a cacheWrite1h split / provider fault),
 * so every field that must survive runtime→analytics is exercised on a real
 * persisted row.
 *
 * $ figures are asserted through the `deps` DI seam (mock providers/models
 * are absent from pi-ai's registry, so USD via the default deps is 0 by
 * design; token/turn fields are price-independent and asserted both ways).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { eq, and } from "drizzle-orm";
import {
  setupTestDb,
  getTestDb,
  closeTestDb,
  mockDbConnection,
  mockRealSettings,
} from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentEvents } from "../types";

mockDbConnection();
mockRealSettings();

// ── mutable scenario knobs (closed over by the mocks) ──────────────────
/** One scripted turn the mock Agent replays. */
interface ScriptTurn {
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  /** Synthetic provider usage. cacheRead/cacheWrite/cacheWrite1h omitted ⇒
   *  the provider did not report them (models a non-caching provider). */
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
  };
  /** Stream text but emit NO turn_end — drives finalize.ts's usage-less
   *  fallback assistant row (the ONLY runtime path to a legacy/null-usage row). */
  omitTurnEnd?: boolean;
}

/** Providers whose Agent faults pre-first-token (drives WS2 failover). */
let faultProviders = new Set<string>();
/** Turns the SERVING (non-fault) Agent replays for the current streamChat. */
let serveScript: ScriptTurn[] = [];
let suggestFallbackResult: { provider: string; model: string; tier: string } | null = null;
let resolveModelCalls: string[] = [];

/** Default provider resolveModel returns when the caller pins none. */
const DEFAULT_PROVIDER = "prov-primary";

function piModelFor(provider: string, id = `${provider}-model`) {
  return {
    id,
    provider,
    api: "anthropic-messages",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
}

/** Build the pi-ai `Usage` object the mock Agent emits on turn_end. Cache
 *  fields are only present when the scripted turn set them (faithful to a
 *  provider that omits them). */
function usageObj(u: NonNullable<ScriptTurn["usage"]>): Record<string, unknown> {
  const o: Record<string, unknown> = { input: u.input, output: u.output };
  if (u.cacheRead !== undefined) o.cacheRead = u.cacheRead;
  if (u.cacheWrite !== undefined) o.cacheWrite = u.cacheWrite;
  if (u.cacheWrite1h !== undefined) o.cacheWrite1h = u.cacheWrite1h;
  o.totalTokens = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + u.output;
  o.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return o;
}

mock.module("../providers/router", () => ({
  // Honor a pinned provider/model; otherwise fall back to DEFAULT_PROVIDER.
  // A routed turn passes no provider → DEFAULT_PROVIDER; the failover
  // resolveAttempt closure passes the suggested fallback provider.
  resolveModel: async (provider?: string, modelId?: string) => {
    const p = provider ?? DEFAULT_PROVIDER;
    resolveModelCalls.push(p);
    const model = modelId ?? `${p}-model`;
    return { provider: p, model, piModel: piModelFor(p, model) };
  },
  suggestFallback: async () => suggestFallbackResult,
  getDefaultTier: async () => "balanced",
  ProviderUnavailableError: class extends Error {
    failedProvider: string;
    failedModel: string;
    suggestion: unknown;
    constructor(msg: string, fp: string, fm: string, sug: unknown) {
      super(msg);
      this.name = "ProviderUnavailableError";
      this.failedProvider = fp;
      this.failedModel = fm;
      this.suggestion = sug;
    }
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
  getApiKey: async () => "test-key",
}));

mock.module("@earendil-works/pi-ai", () => ({
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, result: async () => ({}) }),
  complete: async () => ({}),
  getModel: (provider?: string, modelId?: string) =>
    piModelFor(provider ?? DEFAULT_PROVIDER, modelId ?? undefined),
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
}));

// Mock pi-agent-core Agent: replay serveScript for a serving provider, fault
// pre-first-token for a faultProviders provider. Behaviour keys off the
// constructed model's provider (exactly like executor-failover's mock).
mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state: { errorMessage?: string } = {};
    private _subs: Array<(e: unknown) => void> = [];
    private _provider: string;
    constructor(opts: any) {
      this._provider = opts?.initialState?.model?.provider ?? "unknown";
    }
    subscribe(cb: (e: unknown) => void) {
      this._subs.push(cb);
      return () => {};
    }
    abort() {}
    async prompt() {
      const emit = (e: unknown) => {
        for (const s of this._subs) s(e);
      };
      if (faultProviders.has(this._provider)) {
        // pi-agent-core stores the provider failure on state (no throw).
        this.state.errorMessage = "429 Too Many Requests";
        return;
      }
      for (const turn of serveScript) {
        emit({ type: "turn_start" });
        if (turn.toolCall) {
          emit({
            type: "tool_execution_start",
            toolCallId: turn.toolCall.id,
            toolName: turn.toolCall.name,
            args: turn.toolCall.args,
          });
        }
        if (turn.text) {
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: turn.text },
          });
        }
        if (turn.omitTurnEnd) continue;
        emit({
          type: "turn_end",
          message: {
            role: "assistant",
            content: turn.text ? [{ type: "text", text: turn.text }] : [],
            usage: usageObj(turn.usage ?? { input: 0, output: 0 }),
          },
        });
      }
    }
  },
}));

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { users, projects, messages } from "../db/schema";
import { createConversation } from "../db/queries/conversations";
import { resetAllCircuitBreakers } from "../providers/circuit-breaker";
import {
  getSavingsForUser,
  type SavingsPricingDeps,
} from "../db/queries/savings-analytics";
import {
  computeRowCacheSavings,
  computeServedCostUsd,
  type ModelCostLike,
} from "../runtime/usage/savings";

// ── Deterministic price sheets for the injected-deps ($ assertions) ──
const BAL: ModelCostLike = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const POW: ModelCostLike = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const FAST: ModelCostLike = { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 };
const COST_BY_MODEL: Record<string, ModelCostLike> = {
  "prov-pow-model": POW,
  "prov-fast-model": FAST,
};
/** Served cost by model id, defaulting every other served model to BAL. */
function costForModel(model: string): ModelCostLike {
  return COST_BY_MODEL[model] ?? BAL;
}
/** Injected pricing deps: served cost keyed by model, balanced counterfactual
 *  always BAL, no subscription providers. Mirrors the real deps contract but
 *  fully deterministic (the mock providers/models aren't in pi-ai's registry). */
const fixedDeps: SavingsPricingDeps = {
  getModelCost: (_provider, model) => costForModel(model),
  getCounterfactualCost: () => BAL,
  isSubscriptionProvider: async () => false,
};

const PROJECT_ID = "p-sav-rt";
// One user per scenario so getSavingsForUser scopes cleanly to the scenario.
const U1 = "u-rt-pinned";
const U2 = "u-rt-routed";
const U3 = "u-rt-failover";
const U4 = "u-rt-multi";
const U5 = "u-rt-nocache";

const executor = new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: true });

/** Drive one real streamChat turn; assert it succeeded. */
async function drive(
  convId: string,
  userMessage: string,
  options: Record<string, unknown>,
  script: ScriptTurn[],
  faults: string[] = [],
  fallback: { provider: string; model: string; tier: string } | null = null,
) {
  faultProviders = new Set(faults);
  serveScript = script;
  suggestFallbackResult = fallback;
  const run = await executor.streamChat(convId, userMessage, options);
  return run;
}

/** The assistant rows the runtime persisted for a conversation (source of truth). */
async function persistedAssistantRows(convId: string) {
  const rows = await getTestDb()
    .select({ provider: messages.provider, model: messages.model, role: messages.role, usage: messages.usage })
    .from(messages)
    .where(and(eq(messages.conversationId, convId), eq(messages.role, "assistant")));
  return rows;
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.insert(users).values([
    { id: U1, email: "u1@rt.com", passwordHash: "x", name: "U1", role: "member" } as any,
    { id: U2, email: "u2@rt.com", passwordHash: "x", name: "U2", role: "member" } as any,
    { id: U3, email: "u3@rt.com", passwordHash: "x", name: "U3", role: "member" } as any,
    { id: U4, email: "u4@rt.com", passwordHash: "x", name: "U4", role: "member" } as any,
    { id: U5, email: "u5@rt.com", passwordHash: "x", name: "U5", role: "member" } as any,
  ]);
  await db.insert(projects).values([{ id: PROJECT_ID, name: "rt", path: "/tmp/rt" } as any]);
}, 30_000);

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  faultProviders = new Set();
  serveScript = [];
  suggestFallbackResult = null;
  resolveModelCalls = [];
  resetAllCircuitBreakers();
});

// ══════════════════════════════════════════════════════════════════════
// Scenario 1 — pinned-model turn with cacheRead + cacheWrite + 1h split
// ══════════════════════════════════════════════════════════════════════
describe("Scenario 1 — pinned turn: cacheRead/cacheWrite/1h split → aggregation, hitRate", () => {
  test("runtime persists the cache meter; savings aggregates it exactly", async () => {
    const conv = await createConversation(PROJECT_ID, { title: "s1", userId: U1 });
    const run = await drive(
      conv.id,
      "pinned please",
      { provider: "prov-pinned", model: "prov-pinned-model" },
      [{ text: "answer", usage: { input: 100, output: 50, cacheRead: 800, cacheWrite: 300, cacheWrite1h: 120 } }],
    );
    expect(run.status).toBe("success");

    // ── SOURCE OF TRUTH: the persisted row ──
    const rows = await persistedAssistantRows(conv.id);
    expect(rows).toHaveLength(1);
    const u = rows[0]!.usage!;
    expect(rows[0]!.provider).toBe("prov-pinned");
    expect(rows[0]!.model).toBe("prov-pinned-model");
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(50);
    expect(u.cacheReadTokens).toBe(800);
    expect(u.cacheWriteTokens).toBe(300);
    expect(u.cacheWrite1hTokens).toBe(120);
    expect(u.cacheHitRate).toBeCloseTo(800 / 1200, 12);
    // Pinned ⇒ requestedModel is the pin (NOT null) and no routedTier written.
    expect(u.requestedModel).toBe("prov-pinned-model");
    expect(u.requestedProvider).toBe("prov-pinned");
    expect(u.routedTier).toBeUndefined();
    expect(u.failover).toBe(false);

    // ── savings vs the persisted truth + a-priori expectation ──
    const report = await getSavingsForUser(U1, 30, fixedDeps);
    expect(report.stats.turnsTotal).toBe(1);
    expect(report.stats.turnsRouted).toBe(0); // pinned ⇒ not routed
    expect(report.stats.turnsFailover).toBe(0);
    expect(report.stats.tokensCachedRead).toBe(800);
    expect(report.stats.tokensCacheWritten).toBe(300);
    expect(report.stats.cacheHitRate).toBeCloseTo(800 / 1200, 12);

    // Hand-computed $ from BAL over the persisted token mix.
    const expected = computeRowCacheSavings(BAL, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 300,
      cacheWrite1hTokens: 120,
    });
    expect(report.stats.cacheReadSavedUsd).toBeCloseTo(expected.readSavedUsd, 12);
    expect(report.stats.cacheSavedUsd).toBeCloseTo(expected.cacheSavedUsd, 12);
    expect(report.stats.write1hPremiumUsd).toBeCloseTo(expected.write1hPremiumUsd, 12);
    expect(report.stats.write1hPremiumUsd).toBeGreaterThan(0);
    expect(report.stats.routingSavedUsd).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Scenario 2 — routed turns: served columns + routedTier; routing $ sign
// ══════════════════════════════════════════════════════════════════════
describe("Scenario 2 — routed turns persist served identity + routedTier; routing $ sign matches tier", () => {
  test("powerful ⇒ negative routing $, fast ⇒ positive; turnsRouted counts both", async () => {
    const convPow = await createConversation(PROJECT_ID, { title: "s2-pow", userId: U2 });
    const convFast = await createConversation(PROJECT_ID, { title: "s2-fast", userId: U2 });

    // No model pin ⇒ routing fires. tier hint pins the classifier deterministically.
    await drive(convPow.id, "route me", { provider: "prov-pow", tier: "powerful" }, [
      { text: "pow", usage: { input: 1000, output: 100 } },
    ]);
    await drive(convFast.id, "route me", { provider: "prov-fast", tier: "fast" }, [
      { text: "fast", usage: { input: 1000, output: 100 } },
    ]);

    // ── persisted truth: served columns + routing provenance ──
    const powRow = (await persistedAssistantRows(convPow.id))[0]!;
    expect(powRow.provider).toBe("prov-pow");
    expect(powRow.model).toBe("prov-pow-model"); // SERVED model, not undefined
    expect(powRow.usage!.requestedModel).toBeNull(); // routed (no pin)
    expect(powRow.usage!.requestedProvider).toBe("prov-pow");
    expect(powRow.usage!.routedTier).toBe("powerful");
    expect(powRow.usage!.failover).toBe(false);

    const fastRow = (await persistedAssistantRows(convFast.id))[0]!;
    expect(fastRow.provider).toBe("prov-fast");
    expect(fastRow.model).toBe("prov-fast-model");
    expect(fastRow.usage!.requestedModel).toBeNull();
    expect(fastRow.usage!.routedTier).toBe("fast");

    // ── savings: routing sign matches the tier ──
    const report = await getSavingsForUser(U2, 30, fixedDeps);
    expect(report.stats.turnsTotal).toBe(2);
    expect(report.stats.turnsRouted).toBe(2);

    const tokens = { inputTokens: 1000, outputTokens: 100 };
    const routePow = computeServedCostUsd(BAL, tokens) - computeServedCostUsd(POW, tokens);
    const routeFast = computeServedCostUsd(BAL, tokens) - computeServedCostUsd(FAST, tokens);
    expect(routePow).toBeLessThan(0);
    expect(routeFast).toBeGreaterThan(0);

    const byModel = new Map(report.perModel.map((g) => [`${g.provider}/${g.model}`, g]));
    expect(byModel.get("prov-pow/prov-pow-model")!.routingSavedUsd).toBeCloseTo(routePow, 12);
    expect(byModel.get("prov-pow/prov-pow-model")!.routingSavedUsd).toBeLessThan(0);
    expect(byModel.get("prov-fast/prov-fast-model")!.routingSavedUsd).toBeCloseTo(routeFast, 12);
    expect(byModel.get("prov-fast/prov-fast-model")!.routingSavedUsd).toBeGreaterThan(0);
    expect(report.stats.routingSavedUsd).toBeCloseTo(routePow + routeFast, 12);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Scenario 3 — pre-first-token fault → fallback serves; failover persisted
// ══════════════════════════════════════════════════════════════════════
describe("Scenario 3 — provider failover: usage.failover persisted; served = FALLBACK model", () => {
  test("turnsFailover=1 and the fallback model appears in perModel", async () => {
    const conv = await createConversation(PROJECT_ID, { title: "s3", userId: U3 });
    // options={} ⇒ initial resolves to DEFAULT_PROVIDER (which faults); the
    // router suggests prov-fallback, which serves the turn.
    const run = await drive(
      conv.id,
      "hello",
      {},
      [{ text: "served by fallback", usage: { input: 50, output: 20, cacheRead: 100, cacheWrite: 0 } }],
      [DEFAULT_PROVIDER],
      { provider: "prov-fallback", model: "prov-fallback-model", tier: "fast" },
    );
    expect(run.status).toBe("success");
    // The failover actually happened: initial DEFAULT_PROVIDER + fallback resolve.
    expect(resolveModelCalls).toEqual([DEFAULT_PROVIDER, "prov-fallback"]);

    // ── persisted truth: exactly ONE row, named by the FALLBACK model ──
    const rows = await persistedAssistantRows(conv.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.provider).toBe("prov-fallback");
    expect(row.model).toBe("prov-fallback-model");
    expect(row.usage!.failover).toBe(true);
    expect(row.usage!.requestedModel).toBeNull(); // routed (no pin)
    expect(row.usage!.routedTier).toBe("fast");

    // ── savings ──
    const report = await getSavingsForUser(U3, 30, fixedDeps);
    expect(report.stats.turnsTotal).toBe(1);
    expect(report.stats.turnsFailover).toBe(1);
    const byModel = new Map(report.perModel.map((g) => [`${g.provider}/${g.model}`, g]));
    expect(byModel.has("prov-fallback/prov-fallback-model")).toBe(true);
    expect(byModel.get("prov-fallback/prov-fallback-model")!.turns).toBe(1);
    expect(byModel.get("prov-fallback/prov-fallback-model")!.tokensCachedRead).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Scenario 4 — multi-turn conversation incl. a tool-looping turn
// ══════════════════════════════════════════════════════════════════════
describe("Scenario 4 — multi-turn incl. tool loop: every persisted turn aggregates, no double-count", () => {
  test("4 assistant rows across 3 streamChat calls sum correctly", async () => {
    const conv = await createConversation(PROJECT_ID, { title: "s4", userId: U4 });

    // Call A — one terminal turn (cache WRITE turn).
    await drive(conv.id, "turn one", { provider: "prov-multi" }, [
      { text: "a", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 200 } },
    ]);
    // Call B — tool loop: an intermediate tool turn (persisted on its own) then
    // a terminal synthesis turn (reads cache). TWO assistant rows from ONE call.
    await drive(conv.id, "turn two", { provider: "prov-multi" }, [
      { toolCall: { id: "tc-1", name: "grep", args: { pattern: "x" } }, usage: { input: 200, output: 10, cacheRead: 0, cacheWrite: 900 } },
      { text: "b", usage: { input: 50, output: 30, cacheRead: 900, cacheWrite: 0 } },
    ]);
    // Call C — one terminal turn.
    await drive(conv.id, "turn three", { provider: "prov-multi" }, [
      { text: "c", usage: { input: 60, output: 20, cacheRead: 100, cacheWrite: 0 } },
    ]);

    // ── SOURCE OF TRUTH: FOUR assistant rows, one per turn_end ──
    const rows = await persistedAssistantRows(conv.id);
    expect(rows).toHaveLength(4);
    // Sum the persisted rows directly and confirm the query matches (proves no
    // double-count from the intermediate tool turn).
    const sumRead = rows.reduce((n, r) => n + (r.usage?.cacheReadTokens ?? 0), 0);
    const sumWritten = rows.reduce((n, r) => n + (r.usage?.cacheWriteTokens ?? 0), 0);
    expect(sumRead).toBe(0 + 0 + 900 + 100); // 1000
    expect(sumWritten).toBe(200 + 900 + 0 + 0); // 1100

    const report = await getSavingsForUser(U4, 30, fixedDeps);
    expect(report.stats.turnsTotal).toBe(4); // every turn_end row counted once
    expect(report.stats.tokensCachedRead).toBe(sumRead);
    expect(report.stats.tokensCacheWritten).toBe(sumWritten);
    // Hit-rate over ALL four (each is cache-eligible): Σread / Σprompt.
    const sumPrompt = rows.reduce(
      (n, r) => n + (r.usage?.inputTokens ?? 0) + (r.usage?.cacheReadTokens ?? 0) + (r.usage?.cacheWriteTokens ?? 0),
      0,
    );
    expect(report.stats.cacheHitRate).toBeCloseTo(sumRead / sumPrompt, 12);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Scenario 5 — no cache fields from the provider + a true legacy (null) row
// ══════════════════════════════════════════════════════════════════════
describe("Scenario 5 — provider omits cache fields vs a true legacy/null-usage row", () => {
  test("runtime NORMALIZES omitted cache fields to 0 (cache-eligible); only a null-usage row is hit-rate-excluded", async () => {
    // 5a — provider reports NO cache fields. The runtime normalizes them to 0,
    //      so the persisted row IS cache-eligible (0% hit), NOT a legacy row.
    const convA = await createConversation(PROJECT_ID, { title: "s5a", userId: U5 });
    await drive(convA.id, "no cache", { provider: "prov-nocache" }, [
      { text: "plain", usage: { input: 100, output: 10 } }, // cacheRead/cacheWrite omitted
    ]);

    // 5b — stream text but NO turn_end ⇒ finalize.ts persists a usage-less
    //      fallback row: the ONLY runtime path to a genuine legacy/null row.
    const convB = await createConversation(PROJECT_ID, { title: "s5b", userId: U5 });
    await drive(convB.id, "legacy", { provider: "prov-legacy" }, [
      { text: "partial", omitTurnEnd: true },
    ]);

    // ── persisted truth ──
    const aRow = (await persistedAssistantRows(convA.id))[0]!;
    expect(aRow.usage!.cacheReadTokens).toBe(0); // normalized present-zero (NOT absent)
    expect(aRow.usage!.cacheWriteTokens).toBe(0);
    expect(aRow.usage!.cacheHitRate).toBe(0);

    const bRow = (await persistedAssistantRows(convB.id))[0]!;
    expect(bRow.usage).toBeNull(); // true legacy row (no cache meter at all)

    // ── savings ──
    const report = await getSavingsForUser(U5, 30, fixedDeps);
    expect(report.stats.turnsTotal).toBe(2); // BOTH rows counted in turnsTotal
    // 5a is cache-eligible with 0 hits; 5b (null usage) is EXCLUDED from hit-rate.
    expect(report.stats.cacheHitRate).toBeCloseTo(0, 12);

    const byModel = new Map(report.perModel.map((g) => [`${g.provider}/${g.model}`, g]));
    // 5a group: eligible ⇒ hitRate 0 (a real 0%, not null).
    expect(byModel.get("prov-nocache/prov-nocache-model")!.cacheHitRate).toBe(0);
    // 5b group: null usage ⇒ NO eligible turn ⇒ hitRate null (excluded).
    const legacyGroup = byModel.get("prov-legacy/unknown")!;
    expect(legacyGroup.turns).toBe(1);
    expect(legacyGroup.cacheHitRate).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Route parity — the GET handler serves what the query computed
// ══════════════════════════════════════════════════════════════════════
describe("Route parity — /api/analytics/savings serves the same token/turn numbers", () => {
  test("default-deps report (as the route calls it) matches the DI token/turn fields", async () => {
    // The route handler calls getSavingsForUser(user.id, days) with the DEFAULT
    // deps. Mock providers/models are absent from pi-ai's registry ⇒ USD is 0 by
    // design, but token/turn fields are price-independent and must match.
    const di = await getSavingsForUser(U4, 30, fixedDeps);
    const asRoute = await getSavingsForUser(U4, 30); // exactly what +server.ts runs

    expect(asRoute.rangeDays).toBe(di.rangeDays);
    expect(asRoute.estimated).toBe(true);
    expect(asRoute.stats.turnsTotal).toBe(di.stats.turnsTotal);
    expect(asRoute.stats.turnsRouted).toBe(di.stats.turnsRouted);
    expect(asRoute.stats.turnsFailover).toBe(di.stats.turnsFailover);
    expect(asRoute.stats.tokensCachedRead).toBe(di.stats.tokensCachedRead);
    expect(asRoute.stats.tokensCacheWritten).toBe(di.stats.tokensCacheWritten);
    expect(asRoute.stats.cacheHitRate).toBeCloseTo(di.stats.cacheHitRate!, 12);
    // Default-deps USD is 0 (mock models unpriced) — the documented no-DI truth.
    expect(asRoute.stats.cacheSavedUsd).toBe(0);
    expect(asRoute.stats.routingSavedUsd).toBe(0);
  });
});
