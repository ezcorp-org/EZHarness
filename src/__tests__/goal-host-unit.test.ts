/**
 * Unit tests for `src/runtime/goal-host.ts` — PRD §11.1 (U1-U7).
 *
 * 100% per-file coverage on every pure function + class branch. The
 * GoalHost class is exercised with constructor-injected fakes for
 * `bus`, `executor`, persistence, model resolution, pi-ai complete,
 * and conversation queries — no live DB, no real LLM.
 *
 * Test scope:
 *   U1 — slash-prefix parser (isGoalCommand + parseGoalCommand): every
 *        case from PRD §11.1 U1, including `/goalpost` non-match, all
 *        clear aliases (case variants), `/goal CLEAR something` = set,
 *        4001-char reject, 4000-char accept, multi-line set.
 *   U2 — evaluator response parser: yes/no, malformed, code-fence
 *        wrappers, non-JSON-with-yes-text, missing/wrong-type fields.
 *   U3 — evaluator model resolver: each provider → correct cheap
 *        model; missing-credential fallback chain; no-model → null
 *        (pause signal).
 *   U4 — state machine on the canonical armed predicate: all
 *        transitions; assertion that no `armed` boolean exists on the
 *        persisted shape (grep-style).
 *   U5 — FR-9 SQL aggregation correctness verified via a fake
 *        compute-fn; in-memory cache reconciles to it.
 *   U6 — `metadata.goal` read/write/delete + absent-key semantics.
 *   U7 — return-shape sanity: set → `kind:"start-turn"`; status/clear/
 *        reject → `kind:"card"` with non-null row.
 */

import { test, expect, describe, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHEAP_MODEL_BY_PROVIDER,
  CLEAR_ALIASES,
  EVALUATOR_FAILURE_THRESHOLD,
  EVALUATOR_MAX_OUTPUT_TOKENS,
  EVALUATOR_TIMEOUT_MS,
  GoalHost,
  MAX_GOAL_CONDITION_LENGTH,
  buildAchievedCard,
  buildClearedCard,
  buildContinuationPrompt,
  buildDisabledCard,
  buildEvaluatorTranscript,
  buildNoGoalCard,
  buildPausedCard,
  buildRejectTooLongCard,
  buildStatusCard,
  buildTurnCapCard,
  detectSentinel,
  invokeEvaluator,
  isGoalArmed,
  isGoalCommand,
  parseEvaluatorResponse,
  parseGoalCommand,
  parseGoalEnabled,
  resolveEvaluatorModel,
  _resetGoalHostSingleton,
  getGoalHost,
  initGoalHost,
  type CompleteFn,
  type CredentialFn,
  type GoalRecord,
  type PersistedGoal,
  type ResolveModelFn,
  type ResolvedEvaluatorModel,
} from "../runtime/goal-host";
import { EventBus } from "../runtime/events";
import { PREPROCESS_RESULT_ROLE } from "../runtime/stream-chat/preprocess-shared";
import type { AgentEvents, AgentRun } from "../types";
import type { AgentExecutor } from "../runtime/executor";

// ── Test fixtures ───────────────────────────────────────────────────

function makeBus(): EventBus<AgentEvents> {
  return new EventBus<AgentEvents>();
}

interface FakeExecutorCall {
  conversationId: string;
  userMessage: string;
  options: Record<string, unknown>;
}

function makeFakeExecutor(): { executor: AgentExecutor; calls: FakeExecutorCall[] } {
  const calls: FakeExecutorCall[] = [];
  const executor = {
    streamChat: async (
      conversationId: string,
      userMessage: string,
      options: Record<string, unknown>,
    ) => {
      calls.push({ conversationId, userMessage, options });
      return {
        id: (options.runId as string) ?? "fake-run",
        agentName: "chat",
        status: "running",
        startedAt: Date.now(),
        logs: [],
      } as unknown as AgentRun;
    },
  } as unknown as AgentExecutor;
  return { executor, calls };
}

interface FakeStore {
  persisted: Map<string, PersistedGoal>;
  rows: Array<{ id: string; role: string; content: string; conversationId: string; parentMessageId?: string }>;
}

function makeStore(): FakeStore {
  return { persisted: new Map(), rows: [] };
}

interface HostHarness {
  host: GoalHost;
  store: FakeStore;
  bus: EventBus<AgentEvents>;
  execCalls: FakeExecutorCall[];
  emitted: AgentEvents["goal:update"][];
  pendingByConv: Map<string, unknown>;
  scanReturn: { value: Array<{ id: string; persisted: PersistedGoal }> };
  completeMock: ReturnType<typeof mock>;
  computeSpendValue: { value: number };
  nowValue: { value: number };
  resolveModelMock: ReturnType<typeof mock>;
  getCredentialMock: ReturnType<typeof mock>;
  getMessagesByConv: Map<string, Array<{ role: string; content: string; excluded?: boolean }>>;
}

function makeHost(opts: {
  enabled?: boolean;
  maxGoalTurns?: number;
  initialPersisted?: Record<string, PersistedGoal>;
  initialMessages?: Record<string, Array<{ role: string; content: string; excluded?: boolean }>>;
  completeFn?: (...args: unknown[]) => Promise<unknown>;
  resolveModelImpl?: (provider?: string, model?: string) => Promise<{ provider: string; model: string; piModel: unknown }>;
  getCredentialImpl?: (provider: string, conversationId?: string) => Promise<{ type: string; token: string }>;
  scanReturn?: Array<{ id: string; persisted: PersistedGoal }>;
  computeSpend?: number;
} = {}): HostHarness {
  const store = makeStore();
  if (opts.initialPersisted) {
    for (const [convId, g] of Object.entries(opts.initialPersisted)) {
      store.persisted.set(convId, g);
    }
  }
  const bus = makeBus();
  const emitted: AgentEvents["goal:update"][] = [];
  bus.on("goal:update", (e) => emitted.push(e));
  const { executor, calls } = makeFakeExecutor();
  const pendingByConv = new Map<string, unknown>();
  const scanReturn = { value: opts.scanReturn ?? [] };
  const completeMock =
    opts.completeFn
      ? mock(opts.completeFn)
      : mock(async () => ({
          content: [{ type: "text", text: '{"achieved":false,"reason":"keep going"}' }],
          usage: { input: 10, output: 5 },
          stopReason: "stop",
        }));
  const computeSpendValue = { value: opts.computeSpend ?? 0 };
  const nowValue = { value: 1_700_000_000_000 };

  const resolveModelMock =
    opts.resolveModelImpl
      ? mock(opts.resolveModelImpl)
      : mock(async (provider?: string, model?: string) => ({
          provider: provider ?? "anthropic",
          model: model ?? "claude-haiku-4-5-20250514",
          piModel: { __fake: true },
        }));
  const getCredentialMock =
    opts.getCredentialImpl
      ? mock(opts.getCredentialImpl)
      : mock(async (_provider: string, _conversationId?: string) => ({
          type: "apikey",
          token: "fake-token",
        }));

  const getMessagesByConv = new Map<string, Array<{ role: string; content: string; excluded?: boolean }>>();
  if (opts.initialMessages) {
    for (const [k, v] of Object.entries(opts.initialMessages)) {
      getMessagesByConv.set(k, v);
    }
  }

  const host = new GoalHost({
    bus,
    executor,
    enabled: opts.enabled ?? true,
    maxGoalTurns: opts.maxGoalTurns ?? 50,
    now: () => nowValue.value,
    resolveModel: resolveModelMock as unknown as Parameters<typeof initGoalHost>[0]["resolveModel"],
    getCredential: getCredentialMock as unknown as Parameters<typeof initGoalHost>[0]["getCredential"],
    complete: completeMock as unknown as Parameters<typeof initGoalHost>[0]["complete"],
    readGoal: async (id: string) => store.persisted.get(id),
    writeGoal: async (id: string, goal: PersistedGoal) => {
      store.persisted.set(id, goal);
    },
    deleteGoal: async (id: string) => {
      store.persisted.delete(id);
    },
    scanGoalConversations: async () => scanReturn.value,
    computeTokenSpend: async () => computeSpendValue.value,
    getMessages: async (id: string) => {
      const arr = getMessagesByConv.get(id) ?? [];
      return arr.map((m, idx) => ({
        id: `msg-${idx}`,
        conversationId: id,
        role: m.role,
        content: m.content,
        thinkingContent: null,
        model: null,
        provider: null,
        usage: null,
        runId: null,
        parentMessageId: null,
        excluded: m.excluded ?? false,
        createdAt: new Date(),
      })) as unknown as Awaited<ReturnType<typeof import("../db/queries/conversations").getMessages>>;
    },
    createMessage: async (conversationId: string, data: { role: string; content: string; parentMessageId?: string }) => {
      const id = `row-${store.rows.length + 1}`;
      const row = {
        id,
        role: data.role,
        content: data.content,
        conversationId,
        ...(data.parentMessageId ? { parentMessageId: data.parentMessageId } : {}),
      };
      store.rows.push(row);
      return {
        id,
        conversationId,
        role: data.role,
        content: data.content,
        thinkingContent: null,
        model: null,
        provider: null,
        usage: null,
        runId: null,
        parentMessageId: data.parentMessageId ?? null,
        excluded: false,
        createdAt: new Date(),
      } as unknown as Awaited<ReturnType<typeof import("../db/queries/conversations").createMessage>>;
    },
    dequeuePending: (conversationId: string) => pendingByConv.get(conversationId),
  });

  return {
    host,
    store,
    bus,
    execCalls: calls,
    emitted,
    pendingByConv,
    scanReturn,
    completeMock,
    computeSpendValue,
    nowValue,
    resolveModelMock,
    getCredentialMock,
    getMessagesByConv,
  };
}

// ── U1: slash-prefix parser ─────────────────────────────────────────

describe("U1 — slash-prefix parser (isGoalCommand + parseGoalCommand)", () => {
  test("`/goal` → status", () => {
    expect(isGoalCommand("/goal")).toBe(true);
    expect(parseGoalCommand("/goal")).toEqual({ subcommand: "status" });
  });

  test("`/goal   ` (trailing whitespace only) → status", () => {
    expect(isGoalCommand("/goal   ")).toBe(true);
    expect(parseGoalCommand("/goal   ")).toEqual({ subcommand: "status" });
  });

  test("`/goal\\n` (trailing newline only) → status", () => {
    expect(isGoalCommand("/goal\n")).toBe(true);
    expect(parseGoalCommand("/goal\n")).toEqual({ subcommand: "status" });
  });

  test("`/goal\\t` → status", () => {
    expect(isGoalCommand("/goal\t")).toBe(true);
  });

  test("`/goal\\r` → status", () => {
    expect(isGoalCommand("/goal\r")).toBe(true);
  });

  test("`/goalpost x` does NOT match (prefix must be token)", () => {
    expect(isGoalCommand("/goalpost x")).toBe(false);
  });

  test("`/goalish` does NOT match", () => {
    expect(isGoalCommand("/goalish")).toBe(false);
  });

  test("`  /goal foo` (leading whitespace) matches via trimStart", () => {
    expect(isGoalCommand("  /goal foo")).toBe(true);
    expect(parseGoalCommand("  /goal foo")).toEqual({
      subcommand: "set",
      condition: "foo",
    });
  });

  // `CLEAR_ALIASES` is `readonly string[]` (PRD invariant — host
  // constant, not mutable). `test.each` wants a mutable array, so
  // spread into a fresh `string[]` for each cohort.
  test.each([...CLEAR_ALIASES])("`/goal %s` → clear (lowercase)", (alias: string) => {
    expect(parseGoalCommand(`/goal ${alias}`)).toEqual({ subcommand: "clear" });
  });

  test.each([...CLEAR_ALIASES])("`/goal %s` (uppercase) → clear (case-insensitive)", (alias: string) => {
    expect(parseGoalCommand(`/goal ${alias.toUpperCase()}`)).toEqual({ subcommand: "clear" });
  });

  test.each([...CLEAR_ALIASES])("`/goal %s   ` (trailing whitespace) → clear", (alias: string) => {
    expect(parseGoalCommand(`/goal ${alias}   `)).toEqual({ subcommand: "clear" });
  });

  test("`/goal CLEAR something` (multi-token) → set, NOT clear", () => {
    expect(parseGoalCommand("/goal CLEAR something")).toEqual({
      subcommand: "set",
      condition: "CLEAR something",
    });
  });

  test("`/goal clear-with-suffix` (no internal whitespace, but not exact alias) → set", () => {
    expect(parseGoalCommand("/goal clear-with-suffix")).toEqual({
      subcommand: "set",
      condition: "clear-with-suffix",
    });
  });

  test("`/goal <4001-char>` parses as set (length validation is downstream)", () => {
    const long = "x".repeat(4001);
    const result = parseGoalCommand(`/goal ${long}`);
    expect(result.subcommand).toBe("set");
    expect(result.condition!.length).toBe(4001);
  });

  test("`/goal <4000-char>` parses as set", () => {
    const ok = "x".repeat(4000);
    const result = parseGoalCommand(`/goal ${ok}`);
    expect(result.subcommand).toBe("set");
    expect(result.condition!.length).toBe(4000);
  });

  test("`/goal\\n<multi-line condition>` → set with full remainder", () => {
    const result = parseGoalCommand("/goal\nrefactor auth\nuntil tests pass");
    expect(result.subcommand).toBe("set");
    expect(result.condition).toBe("refactor auth\nuntil tests pass");
  });

  test("parseGoalCommand throws on non-/goal input (defensive)", () => {
    expect(() => parseGoalCommand("hi there")).toThrow();
  });
});

// ── U2: evaluator response parser ──────────────────────────────────

describe("U2 — parseEvaluatorResponse", () => {
  test("valid yes JSON", () => {
    const r = parseEvaluatorResponse('{"achieved":true,"reason":"done"}');
    expect(r).toEqual({ achieved: true, reason: "done", parseFailed: false });
  });

  test("valid no JSON", () => {
    const r = parseEvaluatorResponse('{"achieved":false,"reason":"keep going"}');
    expect(r).toEqual({ achieved: false, reason: "keep going", parseFailed: false });
  });

  test("empty string → parseFailed:true, achieved:false", () => {
    const r = parseEvaluatorResponse("");
    expect(r.achieved).toBe(false);
    expect(r.parseFailed).toBe(true);
  });

  test("garbage non-JSON → parseFailed:true", () => {
    const r = parseEvaluatorResponse("yes! we did it");
    expect(r.achieved).toBe(false);
    expect(r.parseFailed).toBe(true);
  });

  test("JSON array (not object) → parseFailed:true", () => {
    const r = parseEvaluatorResponse('[true,"done"]');
    expect(r.parseFailed).toBe(true);
  });

  test("JSON object with non-boolean achieved → parseFailed:true", () => {
    const r = parseEvaluatorResponse('{"achieved":"true","reason":"x"}');
    expect(r.parseFailed).toBe(true);
  });

  test("missing reason → empty string, parseFailed:false", () => {
    const r = parseEvaluatorResponse('{"achieved":true}');
    expect(r).toEqual({ achieved: true, reason: "", parseFailed: false });
  });

  test("non-string reason → empty string fallback", () => {
    const r = parseEvaluatorResponse('{"achieved":false,"reason":42}');
    expect(r).toEqual({ achieved: false, reason: "", parseFailed: false });
  });

  test("reason > 280 chars is clamped, NOT rejected", () => {
    const long = "x".repeat(500);
    const r = parseEvaluatorResponse(`{"achieved":false,"reason":"${long}"}`);
    expect(r.parseFailed).toBe(false);
    expect(r.reason.length).toBe(280);
  });

  test("fenced ```json code wrapper tolerated", () => {
    const r = parseEvaluatorResponse('```json\n{"achieved":true,"reason":"yes"}\n```');
    expect(r).toEqual({ achieved: true, reason: "yes", parseFailed: false });
  });

  test("fenced plain ``` wrapper tolerated", () => {
    const r = parseEvaluatorResponse('```\n{"achieved":false,"reason":"no"}\n```');
    expect(r).toEqual({ achieved: false, reason: "no", parseFailed: false });
  });

  test("null literal → parseFailed:true", () => {
    const r = parseEvaluatorResponse("null");
    expect(r.parseFailed).toBe(true);
  });

  test("whitespace-only input → parseFailed:true", () => {
    const r = parseEvaluatorResponse("   \n   ");
    expect(r.parseFailed).toBe(true);
  });
});

// ── U3: evaluator model resolver ───────────────────────────────────

describe("U3 — resolveEvaluatorModel", () => {
  test("preferred provider with cheap mapping picked first", async () => {
    const resolveModel = mock(async (provider?: string, model?: string) => ({
      provider: provider!,
      model: model!,
      piModel: { provider, model },
    }));
    const getCredential = mock(async () => ({ type: "apikey", token: "k" }));
    const got = await resolveEvaluatorModel("openai", "conv-1", {
      resolveModel: resolveModel as unknown as ResolveModelFn,
      getCredential: getCredential as unknown as CredentialFn,
    });
    expect(got?.provider).toBe("openai");
    expect(got?.model).toBe(CHEAP_MODEL_BY_PROVIDER.openai);
  });

  test("each known provider returns its mapped cheap model", async () => {
    for (const provider of ["anthropic", "google", "openai", "ollama"] as const) {
      const resolveModel = mock(async (p?: string, m?: string) => ({
        provider: p!,
        model: m!,
        piModel: {},
      }));
      const getCredential = mock(async () => ({ type: "apikey", token: "k" }));
      const got = await resolveEvaluatorModel(provider, "c", {
        resolveModel: resolveModel as unknown as ResolveModelFn,
        getCredential: getCredential as unknown as CredentialFn,
      });
      expect(got?.provider).toBe(provider);
      expect(got?.model).toBe(CHEAP_MODEL_BY_PROVIDER[provider]);
    }
  });

  test("missing-credential fallback chain — first provider fails, second wins", async () => {
    const resolveModel = mock(async (p?: string, m?: string) => ({
      provider: p!,
      model: m!,
      piModel: {},
    }));
    let calls = 0;
    const getCredential = mock(async (provider: string) => {
      calls++;
      if (provider === "openai") throw new Error("no creds for openai");
      return { type: "apikey", token: "k" };
    });
    const got = await resolveEvaluatorModel("openai", "c", {
      resolveModel: resolveModel as unknown as ResolveModelFn,
      getCredential: getCredential as unknown as CredentialFn,
    });
    // first try (openai) fails; falls to anthropic (top of FALLBACK_PROVIDERS).
    expect(got?.provider).toBe("anthropic");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("resolveModel throws → that provider skipped, next tried", async () => {
    const resolveModel = mock(async (p?: string, m?: string) => {
      if (p === "anthropic") throw new Error("resolve fail");
      return { provider: p!, model: m!, piModel: {} };
    });
    const getCredential = mock(async () => ({ type: "apikey", token: "k" }));
    const got = await resolveEvaluatorModel("anthropic", "c", {
      resolveModel: resolveModel as unknown as ResolveModelFn,
      getCredential: getCredential as unknown as CredentialFn,
    });
    expect(got?.provider).not.toBe("anthropic");
    expect(got).not.toBeNull();
  });

  test("no provider has credential → returns null (pause signal)", async () => {
    const resolveModel = mock(async (p?: string, m?: string) => ({
      provider: p!,
      model: m!,
      piModel: {},
    }));
    const getCredential = mock(async () => {
      throw new Error("nope");
    });
    const got = await resolveEvaluatorModel("anthropic", "c", {
      resolveModel: resolveModel as unknown as ResolveModelFn,
      getCredential: getCredential as unknown as CredentialFn,
    });
    expect(got).toBeNull();
  });

  test("unknown preferred provider (no cheap mapping) falls back through canonical chain", async () => {
    const resolveModel = mock(async (p?: string, m?: string) => ({
      provider: p!,
      model: m!,
      piModel: {},
    }));
    const getCredential = mock(async () => ({ type: "apikey", token: "k" }));
    const got = await resolveEvaluatorModel("xai-grok", "c", {
      resolveModel: resolveModel as unknown as ResolveModelFn,
      getCredential: getCredential as unknown as CredentialFn,
    });
    expect(got?.provider).toBe("anthropic");
  });

  test("undefined preferred provider → walks canonical chain from the top", async () => {
    const resolveModel = mock(async (p?: string, m?: string) => ({
      provider: p!,
      model: m!,
      piModel: {},
    }));
    const getCredential = mock(async () => ({ type: "apikey", token: "k" }));
    const got = await resolveEvaluatorModel(undefined, "c", {
      resolveModel: resolveModel as unknown as ResolveModelFn,
      getCredential: getCredential as unknown as CredentialFn,
    });
    expect(got?.provider).toBe("anthropic");
  });
});

// ── U4: canonical armed predicate + state-machine asserts ──────────

describe("U4 — canonical armed predicate (single definition)", () => {
  const persisted: PersistedGoal = {
    condition: "do the thing",
    lastReason: null,
    createdAt: "2026-05-20T00:00:00Z",
  };
  const activeRecord: GoalRecord = {
    conversationId: "c1",
    armedAt: 1,
    turnsEvaluated: 0,
    tokenAccumSinceArmed: 0,
    evaluatorFailureCount: 0,
    lastReason: null,
    status: "active",
    inFlightRunId: null,
  };
  const pausedRecord: GoalRecord = { ...activeRecord, status: "paused" };

  test("present + active → armed", () => {
    expect(isGoalArmed(persisted, activeRecord)).toBe(true);
  });

  test("present + paused → NOT armed (paused-ness fails the predicate)", () => {
    expect(isGoalArmed(persisted, pausedRecord)).toBe(false);
  });

  test("present + no record → NOT armed (record-rebuild gap)", () => {
    expect(isGoalArmed(persisted, undefined)).toBe(false);
  });

  test("absent persisted + active record → NOT armed (cleared mid-flight)", () => {
    expect(isGoalArmed(undefined, activeRecord)).toBe(false);
  });

  test("both absent → NOT armed", () => {
    expect(isGoalArmed(undefined, undefined)).toBe(false);
  });

  test("PersistedGoal shape has NO `armed` boolean (grep-the-source assertion)", () => {
    // R11/B5: there must be exactly one armed predicate; the persisted
    // shape MUST NOT carry a boolean. Read the source file and assert
    // no occurrences of `armed: boolean` or `armed: true|false` on the
    // PersistedGoal type definition.
    const src = readFileSync(
      join(import.meta.dir ?? process.cwd(), "..", "runtime", "goal-host.ts"),
      "utf8",
    );
    // Find the PersistedGoal block.
    const m = src.match(/export interface PersistedGoal[\s\S]*?\}/);
    expect(m).not.toBeNull();
    const block = m![0];
    expect(block).not.toMatch(/\barmed\s*:/);
    expect(block).not.toMatch(/\barmed\s*\?\s*:/);
  });
});

// ── U5: token-spend accounting + cache reconciliation ─────────────

describe("U5 — token spend reconciles to SQL on status read", () => {
  test("status read reconciles cache to compute-fn return value", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: null, createdAt: new Date().toISOString() },
      },
      computeSpend: 1234,
    });
    // Seed an active record so status can fully populate.
    await h.host.bootSweep();
    h.scanReturn.value = []; // boot-sweep already populated
    // Now drop and re-seed via the public ensureGoalRecordRehydrated
    // path (the boot sweep above doesn't see the initial persisted map
    // because makeHost wires the scan separately). Instead, seed the
    // store and call rehydrate.
    // (The previous boot-sweep call exercised the empty path; this
    // tests the cache reconcile.)
    await h.host.ensureGoalRecordRehydrated("c1", false);
    const r = await h.host.handleGoalCommand({
      subcommand: "status",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    const record = h.host.getRecord("c1")!;
    expect(record.tokenAccumSinceArmed).toBe(1234);
  });
});

// ── U6: PersistedGoal absent vs. present semantics ────────────────

describe("U6 — metadata.goal absent → no goal; present → armed via record", () => {
  test("status on a conv with no persisted goal returns state:none card", async () => {
    const h = makeHost();
    const r = await h.host.handleGoalCommand({
      subcommand: "status",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    if (r.kind === "card") {
      expect(r.result.card.title).toBe("No active goal");
    }
  });

  test("ensureGoalRecordRehydrated no-ops when metadata.goal absent", async () => {
    const h = makeHost();
    await h.host.ensureGoalRecordRehydrated("c1", false);
    expect(h.host.getRecord("c1")).toBeUndefined();
  });
});

// ── U7: return-shape sanity ────────────────────────────────────────

describe("U7 — handleGoalCommand return shapes", () => {
  test("set (valid) → kind:start-turn; writes persisted goal + emits goal:update active", async () => {
    const h = makeHost();
    const r = await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "refactor auth",
      conversationId: "c-set",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("start-turn");
    expect(h.store.persisted.get("c-set")?.condition).toBe("refactor auth");
    expect(h.host.getRecord("c-set")?.status).toBe("active");
    expect(h.emitted.some((e) => e.state === "active")).toBe(true);
  });

  test("set (4001 chars) → kind:card with too-long reject, no persisted write", async () => {
    const h = makeHost();
    const r = await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "x".repeat(4001),
      conversationId: "c-toolong",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    expect(h.store.persisted.has("c-toolong")).toBe(false);
    expect(h.host.getRecord("c-toolong")).toBeUndefined();
    if (r.kind === "card") {
      expect(r.row).not.toBeNull();
      expect(r.result.kind).toBe("error");
    }
  });

  test("set (4000 chars exactly) → kind:start-turn (boundary)", async () => {
    const h = makeHost();
    const r = await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "x".repeat(4000),
      conversationId: "c-4000",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("start-turn");
  });

  test("set (empty post-trim condition) falls through to status", async () => {
    const h = makeHost();
    const r = await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "    ",
      conversationId: "c-empty",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
  });

  test("clear (no active goal) → kind:card with no-goal card, row persisted", async () => {
    const h = makeHost();
    const r = await h.host.handleGoalCommand({
      subcommand: "clear",
      conversationId: "c-clear",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    if (r.kind === "card") {
      expect(r.row).not.toBeNull();
      expect(r.result.card.title).toBe("No active goal");
    }
  });

  test("clear (active goal) → deletes metadata.goal + drops record + emits off", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: null, createdAt: new Date().toISOString() },
      },
    });
    await h.host.ensureGoalRecordRehydrated("c1", false);
    expect(h.host.getRecord("c1")).not.toBeUndefined();
    const r = await h.host.handleGoalCommand({
      subcommand: "clear",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    expect(h.store.persisted.has("c1")).toBe(false);
    expect(h.host.getRecord("c1")).toBeUndefined();
    expect(h.emitted.some((e) => e.state === "off")).toBe(true);
  });

  test("disabled host → kind:card disabled, row:null", async () => {
    const h = makeHost({ enabled: false });
    const r = await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "x",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    if (r.kind === "card") {
      expect(r.row).toBeNull();
      expect(r.result.card.title).toBe("/goal disabled");
    }
  });

  test("status (active with record) carries condition/elapsed/turns/spend/reason", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: "earlier", createdAt: new Date().toISOString() },
      },
      computeSpend: 7,
    });
    await h.host.ensureGoalRecordRehydrated("c1", false);
    h.nowValue.value += 60_000; // 60s elapsed
    const r = await h.host.handleGoalCommand({
      subcommand: "status",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    if (r.kind === "card") {
      expect(r.result.card.body).toContain("Condition: x");
      expect(r.result.card.body).toContain("Turns evaluated:");
      expect(r.result.card.body).toContain("Token spend (since armed): 7");
    }
  });
});

// ── Run-loop tests on the host ─────────────────────────────────────

describe("GoalHost.start lifecycle", () => {
  test("start() is idempotent; second call is a no-op", async () => {
    const h = makeHost();
    await h.host.start();
    await h.host.start();
    // No throw, no double-listener. We can sanity-check by emitting a
    // run:complete on an unarmed conv and verifying nothing crashes.
    h.bus.emit("run:complete", {
      run: {
        id: "r1",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
      } as unknown as AgentRun,
      conversationId: "nope",
    });
    expect(true).toBe(true); // no throw
  });

  test("start() when disabled is a no-op (no subscriptions)", async () => {
    const h = makeHost({ enabled: false });
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "r1",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
      } as unknown as AgentRun,
      conversationId: "any",
    });
    expect(h.execCalls.length).toBe(0);
    expect(h.host.isEnabled()).toBe(false);
  });

  test("stop() detaches subscriptions", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: null, createdAt: new Date().toISOString() },
      },
    });
    h.scanReturn.value = [
      { id: "c1", persisted: h.store.persisted.get("c1")! },
    ];
    await h.host.start();
    expect(h.host.getRecord("c1")?.status).toBe("active");
    h.host.stop();
    // After stop, records cleared.
    expect(h.host.getRecord("c1")).toBeUndefined();
  });

  test("bootSweep rebuilds GoalRecord from the persisted scan", async () => {
    const persisted: PersistedGoal = {
      condition: "x",
      lastReason: "prev",
      createdAt: new Date().toISOString(),
    };
    const h = makeHost();
    h.scanReturn.value = [{ id: "c1", persisted }];
    await h.host.bootSweep();
    const rec = h.host.getRecord("c1");
    expect(rec).not.toBeUndefined();
    expect(rec!.status).toBe("active");
    expect(rec!.turnsEvaluated).toBe(0);
    expect(rec!.tokenAccumSinceArmed).toBe(0);
    expect(rec!.lastReason).toBe("prev");
  });
});

describe("FR-13b ensureGoalRecordRehydrated", () => {
  test("non-/goal post on a paused conv → flips paused→active and emits", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: null, createdAt: "2026" },
      },
    });
    // Pre-seed a paused record.
    h.scanReturn.value = [
      { id: "c1", persisted: h.store.persisted.get("c1")! },
    ];
    await h.host.bootSweep();
    h.host.getRecord("c1")!.status = "paused";
    h.emitted.length = 0;

    await h.host.ensureGoalRecordRehydrated("c1", false);
    // Re-fetch so TS doesn't carry the narrowed `"paused"` literal
    // type through the await (it has no visibility into the async
    // mutation the rehydrate helper performs on the same object).
    const after = h.host.getRecord("c1")!;
    expect(after.status).toBe("active");
    expect(h.emitted.some((e) => e.state === "active")).toBe(true);
  });

  test("/goal post on a paused conv → does NOT auto-flip (I5d)", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: null, createdAt: "2026" },
      },
    });
    h.scanReturn.value = [
      { id: "c1", persisted: h.store.persisted.get("c1")! },
    ];
    await h.host.bootSweep();
    const rec = h.host.getRecord("c1")!;
    rec.status = "paused";
    h.emitted.length = 0;

    await h.host.ensureGoalRecordRehydrated("c1", true);
    expect(rec.status).toBe("paused");
    expect(h.emitted.filter((e) => e.state === "active").length).toBe(0);
  });

  test("no record exists yet → rehydrate builds one in active state from persisted", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "x", lastReason: "r", createdAt: "2026" },
      },
    });
    expect(h.host.getRecord("c1")).toBeUndefined();
    await h.host.ensureGoalRecordRehydrated("c1", false);
    const rec = h.host.getRecord("c1")!;
    expect(rec.status).toBe("active");
    expect(rec.lastReason).toBe("r");
  });
});

// ── isArmed + lifecycle on the run:complete handler ────────────────

describe("run:complete handler (loop core)", () => {
  function arm(h: HostHarness, conversationId: string): GoalRecord {
    h.store.persisted.set(conversationId, {
      condition: "do x",
      lastReason: null,
      createdAt: "2026",
    });
    const rec: GoalRecord = {
      conversationId,
      armedAt: h.nowValue.value,
      turnsEvaluated: 0,
      tokenAccumSinceArmed: 0,
      evaluatorFailureCount: 0,
      lastReason: null,
      status: "active",
      inFlightRunId: "init-run",
    };
    // Inject into the host's private records map via the rehydrate
    // path (the seeded persisted store ensures it stays).
    h.scanReturn.value = [
      { id: conversationId, persisted: h.store.persisted.get(conversationId)! },
    ];
    return rec;
  }

  test("ignores run:complete for unarmed conversations", async () => {
    const h = makeHost();
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "r1",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
      } as unknown as AgentRun,
      conversationId: "unarmed",
    });
    // Let async handler settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(h.execCalls.length).toBe(0);
  });

  test("achieved:true → deletes metadata.goal + persists achieved row + emits off", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "I have done it." }],
      },
      completeFn: async () => ({
        content: [{ type: "text", text: '{"achieved":true,"reason":"yep"}' }],
        usage: { input: 1, output: 1 },
        stopReason: "stop",
      }),
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.persisted.has("c1")).toBe(false);
    expect(h.host.getRecord("c1")).toBeUndefined();
    expect(h.emitted.some((e) => e.state === "off")).toBe(true);
    const achievedRow = h.store.rows.find((r) =>
      r.content.includes("Goal achieved"),
    );
    expect(achievedRow).not.toBeUndefined();
  });

  test("achieved:false → re-enters streamChat with fresh runId", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
      },
      completeFn: async () => ({
        content: [{ type: "text", text: '{"achieved":false,"reason":"keep going"}' }],
        usage: { input: 1, output: 1 },
        stopReason: "stop",
      }),
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.execCalls.length).toBe(1);
    expect(h.execCalls[0]!.conversationId).toBe("c1");
    const rec = h.host.getRecord("c1");
    expect(rec).not.toBeUndefined();
    expect(rec!.inFlightRunId).not.toBeNull();
  });

  test("pending user message supersedes goal continuation (FR-18)", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
      },
    });
    arm(h, "c1");
    h.pendingByConv.set("c1", { content: "user steering wins" });
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    // Evaluator should NOT have been invoked (steering wins).
    expect(h.completeMock).not.toHaveBeenCalled();
    expect(h.execCalls.length).toBe(0);
  });

  test("turn cap reached → deletes goal + persists 'reached turn cap' row", async () => {
    const h = makeHost({
      maxGoalTurns: 1,
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
      },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.persisted.has("c1")).toBe(false);
    expect(h.host.getRecord("c1")).toBeUndefined();
    const capRow = h.store.rows.find((r) => r.content.includes("reached"));
    expect(capRow).not.toBeUndefined();
  });

  test("3 consecutive evaluator parse failures → pause", async () => {
    let calls = 0;
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
      },
      completeFn: async () => {
        calls++;
        return {
          content: [{ type: "text", text: "garbage non-JSON" }],
          usage: {},
          stopReason: "stop",
        };
      },
    });
    arm(h, "c1");
    await h.host.start();
    // Three back-to-back run:complete events. Each round-trips through
    // the loop and counts as a parse failure. Re-arm `inFlightRunId`
    // manually to mimic the next continuation turn (the host clears it
    // every iteration but doesn't increment internally without a real
    // streamChat completing the runId).
    for (let i = 0; i < EVALUATOR_FAILURE_THRESHOLD; i++) {
      const rec = h.host.getRecord("c1");
      if (rec) rec.inFlightRunId = `r${i}`;
      h.bus.emit("run:complete", {
        run: {
          id: `r${i}`,
          agentName: "chat",
          status: "success",
          startedAt: 0,
          logs: [],
          provider: "anthropic",
        } as unknown as AgentRun,
        conversationId: "c1",
      });
      await new Promise((r) => setTimeout(r, 25));
    }
    const rec = h.host.getRecord("c1");
    expect(rec?.status).toBe("paused");
    expect(calls).toBe(EVALUATOR_FAILURE_THRESHOLD);
    expect(h.emitted.some((e) => e.state === "paused")).toBe(true);
  });

  test("no evaluator model available → pause without crash", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
      },
      getCredentialImpl: async () => {
        throw new Error("no creds anywhere");
      },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    const rec = h.host.getRecord("c1");
    expect(rec?.status).toBe("paused");
  });

  test("sentinel <<TASK_DONE>> in last assistant message → achieved without evaluator call", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "All set <<TASK_DONE>>" }],
      },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 20));
    // Evaluator pi-ai call NOT made.
    expect(h.completeMock).not.toHaveBeenCalled();
    expect(h.store.persisted.has("c1")).toBe(false);
  });

  test("sentinel <<TASK_BLOCKED:reason>> → achieved:false + continues", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "<<TASK_BLOCKED:waiting for input>>" }],
      },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 20));
    // Not achieved; loop continues with the reason surfaced.
    expect(h.completeMock).not.toHaveBeenCalled();
    expect(h.execCalls.length).toBe(1);
  });

  test("run:error → pauses without evaluating (FR-12.5: any run:error)", async () => {
    const h = makeHost({
      initialMessages: { c1: [{ role: "assistant", content: "x" }] },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:error", {
      run: { id: "init-run", agentName: "chat", status: "error", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "c1",
      error: "boom",
    });
    await new Promise((r) => setTimeout(r, 20));
    const rec = h.host.getRecord("c1");
    expect(rec?.status).toBe("paused");
    expect(h.completeMock).not.toHaveBeenCalled();
  });

  test("run:cancel → pauses without evaluating", async () => {
    const h = makeHost({
      initialMessages: { c1: [{ role: "assistant", content: "x" }] },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:cancel", {
      run: { id: "init-run", agentName: "chat", status: "cancelled", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 20));
    const rec = h.host.getRecord("c1");
    expect(rec?.status).toBe("paused");
    expect(h.completeMock).not.toHaveBeenCalled();
  });

  test("watchdog-style run:error (no 'Watchdog' substring) also pauses (FR-12.5)", async () => {
    const h = makeHost({
      initialMessages: { c1: [{ role: "assistant", content: "x" }] },
    });
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:error", {
      run: { id: "init-run", agentName: "chat", status: "error", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "c1",
      error: "idle for 90s",
    });
    await new Promise((r) => setTimeout(r, 20));
    const rec = h.host.getRecord("c1");
    expect(rec?.status).toBe("paused");
    // I4 strengthening (auditor): the watchdog case must NEVER hit the
    // evaluator. The prior I2-style test asserts this for plain
    // run:error; here we lock the same invariant directly on the
    // watchdog-style payload.
    expect(h.completeMock).not.toHaveBeenCalled();
  });

  test("isArmed + run:complete with no conversationId → no-op", async () => {
    const h = makeHost();
    arm(h, "c1");
    await h.host.start();
    h.bus.emit("run:complete", {
      run: { id: "x", agentName: "chat", status: "success", startedAt: 0, logs: [] } as unknown as AgentRun,
      // no conversationId
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.execCalls.length).toBe(0);
  });

  test("isArmed accessor reflects persistence + record state", async () => {
    const h = makeHost();
    arm(h, "c1");
    expect(await h.host.isArmed("c1")).toBe(false); // no record yet
    await h.host.ensureGoalRecordRehydrated("c1", false);
    expect(await h.host.isArmed("c1")).toBe(true);
    const rec = h.host.getRecord("c1")!;
    rec.status = "paused";
    expect(await h.host.isArmed("c1")).toBe(false);
  });

  test("re-/goal <same> while active replaces condition (FR-7 supersede, R10 no double-sub)", async () => {
    const h = makeHost();
    await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "first",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    const recBefore = h.host.getRecord("c1")!;
    expect(recBefore.status).toBe("active");
    await h.host.handleGoalCommand({
      subcommand: "set",
      condition: "second",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um2",
    });
    const recAfter = h.host.getRecord("c1")!;
    expect(h.store.persisted.get("c1")?.condition).toBe("second");
    expect(recAfter.turnsEvaluated).toBe(0); // reset
  });
});

// ── Pure helpers ───────────────────────────────────────────────────

describe("pure helpers", () => {
  test("detectSentinel: done", () => {
    expect(detectSentinel("All done <<TASK_DONE>>")?.achieved).toBe(true);
  });

  test("detectSentinel: blocked with reason", () => {
    const s = detectSentinel("<<TASK_BLOCKED:waiting on user>>");
    expect(s?.achieved).toBe(false);
    expect(s?.reason).toContain("waiting on user");
  });

  test("detectSentinel: blocked with no reason", () => {
    const s = detectSentinel("<<TASK_BLOCKED>>");
    expect(s?.achieved).toBe(false);
    expect(s?.reason).toBe("task blocked");
  });

  test("detectSentinel: no sentinel → null", () => {
    expect(detectSentinel("regular response")).toBeNull();
  });

  test("buildContinuationPrompt with reason", () => {
    expect(buildContinuationPrompt("almost there")).toContain("almost there");
  });

  test("buildContinuationPrompt with empty reason falls back", () => {
    expect(buildContinuationPrompt("   ")).toContain("Continue working");
  });

  test("buildEvaluatorTranscript filters out non-conversational rows + excluded", () => {
    const t = buildEvaluatorTranscript([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "ez-action-result", content: "card" },
      { role: "capability-event", content: "cap" },
      { role: "extension", content: "ext" },
      { role: "assistant", content: "muted", excluded: true },
      { role: "user", content: "again" },
      { role: "assistant", content: "ok" },
    ]);
    expect(t).toHaveLength(4);
    expect(t.every((m) => m.role !== "ez-action-result" as never)).toBe(true);
  });

  test("buildEvaluatorTranscript strips preprocess-result rows (raw tool JSON never reaches the evaluator)", () => {
    // Without the strip, the defensive unknown-role → "user" mapping
    // would feed the row's raw JSON to the evaluator as a fake user turn.
    const rawPayload = JSON.stringify({
      extensionName: "graded-card-scanner",
      toolName: "identify_slab",
      cardType: "grade-delta-chart",
      ok: true,
      output: '{"cert":"49392223","grader":"PSA"}',
    });
    const t = buildEvaluatorTranscript([
      { role: "user", content: "what is this slab worth?" },
      { role: PREPROCESS_RESULT_ROLE, content: rawPayload },
      { role: "assistant", content: "It is a PSA 9 Charizard." },
    ]);
    expect(t).toHaveLength(2);
    expect(t.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(t.some((m) => m.content.includes("grade-delta-chart"))).toBe(false);
  });

  test("buildEvaluatorTranscript window slice keeps the LAST N", () => {
    const arr = Array.from({ length: 30 }, (_v, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const t = buildEvaluatorTranscript(arr, 5);
    expect(t).toHaveLength(5);
    expect(t[0]!.content).toBe("m25");
    expect(t[4]!.content).toBe("m29");
  });

  test("buildEvaluatorTranscript maps unknown roles to user (defensive)", () => {
    const t = buildEvaluatorTranscript([{ role: "weird", content: "x" }]);
    expect(t[0]!.role).toBe("user");
  });

  test("status card builders cover every variant", () => {
    expect(buildStatusCard({ state: "none" }).card.title).toBe("No active goal");
    expect(
      buildStatusCard({
        state: "active",
        condition: "x",
        elapsedMs: 1_000,
        turnsEvaluated: 3,
        tokenSpendSinceArmed: 100,
        lastReason: "ok",
      }).card.title,
    ).toBe("Goal active");
    expect(buildStatusCard({ state: "paused", condition: "x" }).card.title).toBe(
      "Goal paused",
    );
    expect(buildStatusCard({ state: "active" }).card.body).toContain("(unknown)");
    expect(buildClearedCard("x").card.title).toBe("Goal cleared");
    expect(buildClearedCard(undefined).card.title).toBe("Goal cleared");
    expect(buildNoGoalCard().card.title).toBe("No active goal");
    expect(buildAchievedCard("done", "x").card.title).toBe("Goal achieved");
    expect(buildAchievedCard("", "x").card.body).toContain("evaluator marked achieved");
    expect(buildPausedCard("boom", "x").card.title).toBe("Goal paused");
    expect(buildRejectTooLongCard(5000).card.body).toContain(String(MAX_GOAL_CONDITION_LENGTH));
    expect(buildDisabledCard().card.title).toBe("/goal disabled");
    expect(buildTurnCapCard("x", 50).card.body).toContain("50");
  });

  test("status card formats elapsed hours / minutes / seconds", () => {
    const longH = buildStatusCard({ state: "active", condition: "x", elapsedMs: 3 * 3600_000 + 5 * 60_000 + 7_000 });
    expect(longH.card.body).toContain("3h5m7s");
    const longM = buildStatusCard({ state: "active", condition: "x", elapsedMs: 6 * 60_000 + 2_000 });
    expect(longM.card.body).toContain("6m2s");
    const justS = buildStatusCard({ state: "active", condition: "x", elapsedMs: 42_000 });
    expect(justS.card.body).toContain("42s");
    const neg = buildStatusCard({ state: "active", condition: "x", elapsedMs: -5 });
    expect(neg.card.body).toContain("0s");
  });

  test("achieved/cleared card truncate long conditions", () => {
    const long = "x".repeat(500);
    expect(buildAchievedCard("done", long).card.body).toContain("…");
    expect(buildClearedCard(long).card.body).toContain("…");
  });
});

// ── Singleton accessors ────────────────────────────────────────────

describe("singleton accessors", () => {
  test("getGoalHost throws before initGoalHost", () => {
    _resetGoalHostSingleton();
    expect(() => getGoalHost()).toThrow();
  });

  test("initGoalHost is idempotent", () => {
    _resetGoalHostSingleton();
    const bus = makeBus();
    const { executor } = makeFakeExecutor();
    const a = initGoalHost({ bus, executor });
    const b = initGoalHost({ bus, executor });
    expect(a).toBe(b);
    _resetGoalHostSingleton();
  });

  test("getGoalHost returns the singleton after init", () => {
    _resetGoalHostSingleton();
    const bus = makeBus();
    const { executor } = makeFakeExecutor();
    const a = initGoalHost({ bus, executor });
    expect(getGoalHost()).toBe(a);
    _resetGoalHostSingleton();
  });
});

// ── Auditor-flagged validator-gap closures (I-numbers) ─────────────

/**
 * Shared `arm()` helper for the validator-gap tests below. Mirrors the
 * private helper inside `describe("run:complete handler (loop core)")`
 * but lives at module scope so multiple describe blocks can share it.
 *
 * Seeds `metadata.goal` for `conversationId`, registers the
 * conversation with the boot-sweep return-set, and (after the caller's
 * `await h.host.start()` / `bootSweep()`) the in-memory record will
 * exist with `inFlightRunId: null` — callers writing
 * `run:complete`-driven flows should set `inFlightRunId` explicitly
 * before emitting if they want to drive the "stale runId" branch.
 */
function armForValidator(h: HostHarness, conversationId: string): void {
  h.store.persisted.set(conversationId, {
    condition: "do x",
    lastReason: null,
    createdAt: "2026",
  });
  h.scanReturn.value = [
    ...h.scanReturn.value,
    { id: conversationId, persisted: h.store.persisted.get(conversationId)! },
  ];
}

// ── I5c — post-restart token spend resets to 0 ─────────────────────

describe("I-numbers — I5c: post-restart tokenSpendSinceArmed resets to 0", () => {
  test("after a turn completes, simulating a restart re-arms armedAt fresh and reports 0 token spend (no runs ≥ new armedAt)", async () => {
    // Mock compute returns 0 when the SQL would find no runs ≥ armedAt.
    // The U5 test mocks the value flowing in; here we assert the
    // RESET property — bootSweep sets a fresh `armedAt` and the
    // status read uses THAT timestamp to compute spend, so a
    // post-restart status with no new runs yields 0.
    const h = makeHost({
      initialPersisted: {
        c1: {
          condition: "do x",
          lastReason: "prev reason",
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      initialMessages: { c1: [{ role: "assistant", content: "still working" }] },
      computeSpend: 0,
    });
    armForValidator(h, "c1");
    await h.host.start();
    // Run a turn so the host's pre-restart state has `turnsEvaluated > 0`.
    h.host.getRecord("c1")!.inFlightRunId = "init-run";
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.host.getRecord("c1")?.turnsEvaluated).toBeGreaterThanOrEqual(1);

    // Simulate restart: stop the host (drops the in-memory record),
    // then start fresh. The persisted `metadata.goal` is still set, so
    // bootSweep rebuilds the record with a FRESH `armedAt` and reset
    // counters per FR-13a.
    const armedAtPreRestart = h.host.getRecord("c1")!.armedAt;
    h.host.stop();
    expect(h.host.getRecord("c1")).toBeUndefined();
    // Advance the test clock so the post-restart armedAt is provably
    // newer than the pre-restart one.
    h.nowValue.value += 60_000;
    await h.host.start();
    const rebuilt = h.host.getRecord("c1")!;
    expect(rebuilt.armedAt).toBeGreaterThan(armedAtPreRestart);
    expect(rebuilt.turnsEvaluated).toBe(0);
    expect(rebuilt.tokenAccumSinceArmed).toBe(0);

    // Status read now reconciles via the SQL stub (configured to 0,
    // matching "no runs.createdAt ≥ new armedAt").
    const r = await h.host.handleGoalCommand({
      subcommand: "status",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(r.kind).toBe("card");
    expect(h.host.getRecord("c1")!.tokenAccumSinceArmed).toBe(0);
  });
});

// ── I10 — multi-conversation isolation ─────────────────────────────

describe("I-numbers — I10: multi-conversation isolation", () => {
  test("run:complete for c1 advances c1 only; c2 untouched, no streamChat re-entry", async () => {
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
        c2: [{ role: "assistant", content: "different conversation" }],
      },
      completeFn: async () => ({
        // c1's evaluator returns achieved:false → re-entry on c1
        content: [{ type: "text", text: '{"achieved":false,"reason":"keep going"}' }],
        usage: { input: 1, output: 1 },
        stopReason: "stop",
      }),
    });
    armForValidator(h, "c1");
    armForValidator(h, "c2");
    await h.host.start();

    // Snapshot c2's state pre-emit.
    const c2Before = { ...h.host.getRecord("c2")! };

    h.host.getRecord("c1")!.inFlightRunId = "init-run-c1";
    h.bus.emit("run:complete", {
      run: {
        id: "init-run-c1",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));

    // c1: evaluator fired, turnsEvaluated++, streamChat re-entered.
    expect(h.completeMock).toHaveBeenCalledTimes(1);
    const c1 = h.host.getRecord("c1")!;
    expect(c1.turnsEvaluated).toBe(1);
    // c1 streamed exactly once (the re-entry).
    expect(h.execCalls.filter((c) => c.conversationId === "c1")).toHaveLength(1);

    // c2: NOT touched.
    const c2After = h.host.getRecord("c2")!;
    expect(c2After.turnsEvaluated).toBe(c2Before.turnsEvaluated);
    expect(c2After.status).toBe(c2Before.status);
    expect(c2After.armedAt).toBe(c2Before.armedAt);
    // Critically: no streamChat for c2.
    expect(h.execCalls.filter((c) => c.conversationId === "c2")).toHaveLength(0);
  });
});

// ── I1 — full chained set→no→continue→yes→clear cycle ──────────────

describe("I-numbers — I1: full chained evaluator cycle in one test", () => {
  test("arm → run:complete(no) → re-enter → run:complete(yes) → cleared + achieved row", async () => {
    let evalCall = 0;
    const h = makeHost({
      initialMessages: {
        c1: [{ role: "assistant", content: "still working" }],
      },
      completeFn: async () => {
        evalCall++;
        const text =
          evalCall === 1
            ? '{"achieved":false,"reason":"not yet"}'
            : '{"achieved":true,"reason":"all done"}';
        return {
          content: [{ type: "text", text }],
          usage: { input: 1, output: 1 },
          stopReason: "stop",
        };
      },
    });
    armForValidator(h, "c1");
    await h.host.start();

    // First turn: evaluator says no → re-enter streamChat.
    h.host.getRecord("c1")!.inFlightRunId = "init-run";
    h.bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.execCalls).toHaveLength(1);
    const newRunId = h.execCalls[0]!.options.runId as string;
    expect(typeof newRunId).toBe("string");
    expect(newRunId.length).toBeGreaterThan(0);
    const recordMidLoop = h.host.getRecord("c1")!;
    expect(recordMidLoop.inFlightRunId).toBe(newRunId);
    expect(recordMidLoop.turnsEvaluated).toBe(1);
    expect(h.store.persisted.has("c1")).toBe(true); // still armed

    // Second turn: evaluator says yes → goal cleared, achieved row.
    h.bus.emit("run:complete", {
      run: {
        id: newRunId,
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(evalCall).toBe(2);
    expect(h.store.persisted.has("c1")).toBe(false);
    expect(h.host.getRecord("c1")).toBeUndefined();
    expect(h.emitted.some((e) => e.state === "off")).toBe(true);
    const achievedRow = h.store.rows.find((r) => r.content.includes("Goal achieved"));
    expect(achievedRow).not.toBeUndefined();
    // turnsEvaluated reflects both turns BEFORE the record was deleted.
    // We observe the count via the emitted goal:update payloads (the
    // last `state:"off"` carries the latest record's turn count).
    const lastActiveEmit = [...h.emitted].reverse().find((e) => e.state === "active");
    expect(lastActiveEmit?.turnsEvaluated).toBe(1); // emitted right before second turn
  });
});

// ── I13 / R11 race — clear mid-turn does not re-enter ──────────────

describe("I-numbers — I13/R11: clear mid-turn does not re-enter the loop", () => {
  test("handleClear then run:complete for the in-flight runId → no evaluator, no streamChat, no achieved row", async () => {
    const h = makeHost({
      initialMessages: { c1: [{ role: "assistant", content: "still working" }] },
    });
    armForValidator(h, "c1");
    await h.host.start();
    // Mark a run as in-flight (mirroring the pre-clear state).
    h.host.getRecord("c1")!.inFlightRunId = "in-flight-1";

    // Clear via the public command.
    await h.host.handleGoalCommand({
      subcommand: "clear",
      conversationId: "c1",
      userId: "u",
      projectId: "p",
      userMessageId: "um",
    });
    expect(h.store.persisted.has("c1")).toBe(false);
    expect(h.host.getRecord("c1")).toBeUndefined();

    // Now emit run:complete for the in-flight runId. The host's
    // canonical armed predicate (persisted + record both present) is
    // false now → onRunComplete returns early.
    h.bus.emit("run:complete", {
      run: {
        id: "in-flight-1",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));

    // No evaluator, no re-entry, and NO achieved row was written by
    // the loop. The only persisted row from this test is the clear
    // card row.
    expect(h.completeMock).not.toHaveBeenCalled();
    expect(h.execCalls).toHaveLength(0);
    expect(h.store.rows.some((r) => r.content.includes("Goal achieved"))).toBe(false);
    // The clear path persisted a "Goal cleared" row.
    expect(h.store.rows.some((r) => r.content.includes("Goal cleared"))).toBe(true);
  });
});

// ── R3 — lazy rebuild before boot sweep ─────────────────────────────

describe("I-numbers — R3: lazy rebuild then later boot sweep does not duplicate", () => {
  test("ensureGoalRecordRehydrated builds the record; subsequent bootSweep overwrites in place (no duplicate map entries)", async () => {
    const h = makeHost({
      initialPersisted: {
        c1: { condition: "do x", lastReason: "prev", createdAt: "2026" },
      },
    });
    // Pretend the boot sweep hasn't run yet — host is constructed but
    // start()/bootSweep() never called. Lazy rebuild path fires from
    // the messages POST hook.
    expect(h.host.getRecord("c1")).toBeUndefined();
    await h.host.ensureGoalRecordRehydrated("c1", false);
    const afterLazy = h.host.getRecord("c1")!;
    expect(afterLazy).not.toBeUndefined();
    const lazyArmedAt = afterLazy.armedAt;
    expect(afterLazy.status).toBe("active");

    // Now wire up the scan to point at the same conv and run the boot
    // sweep separately (mirrors "boot sweep finishes AFTER a lazy
    // rebuild already happened" race).
    h.scanReturn.value = [
      { id: "c1", persisted: h.store.persisted.get("c1")! },
    ];
    h.nowValue.value += 1000; // distinct armedAt if bootSweep wrote one
    await h.host.bootSweep();

    // Map still has exactly one entry for c1.
    expect(h.host.getRecord("c1")).not.toBeUndefined();
    // bootSweep DOES re-set the record (FR-13a "rebuild") — the test's
    // invariant is "no duplicate map entries, no double-counter
    // explosion": turnsEvaluated stays at 0, evaluatorFailureCount stays
    // at 0. (The armedAt may legitimately advance to the latest
    // `nowFn()` reading; both bootSweep and lazy rebuild reset the
    // counter to 0 by spec.)
    const afterBoot = h.host.getRecord("c1")!;
    expect(afterBoot.turnsEvaluated).toBe(0);
    expect(afterBoot.evaluatorFailureCount).toBe(0);
    expect(afterBoot.tokenAccumSinceArmed).toBe(0);
    // armedAt is either equal to the lazy rebuild's value or advances —
    // never goes backwards.
    expect(afterBoot.armedAt).toBeGreaterThanOrEqual(lazyArmedAt);
  });
});

// ── R7 — evaluator maxTokens clamp + timeout ───────────────────────

describe("I-numbers — R7: evaluator maxTokens clamp + 30s timeout passed to pi-ai", () => {
  test("invokeEvaluator passes maxTokens=512 and timeoutMs=30000 to the complete fn", async () => {
    const captured: Array<{ opts: { maxTokens?: number; timeoutMs?: number } }> = [];
    const fakeComplete: CompleteFn = async (_piModel, _body, opts) => {
      captured.push({ opts });
      return {
        content: [{ type: "text", text: '{"achieved":false,"reason":"x"}' }],
        usage: { input: 1, output: 1 },
        stopReason: "stop",
      };
    };
    const resolved: ResolvedEvaluatorModel = {
      provider: "anthropic",
      model: "claude-haiku-4-5-20250514",
      piModel: { __fake: true },
      credential: { type: "apikey", token: "k" },
    };
    await invokeEvaluator(resolved, "do x", [], { complete: fakeComplete });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.opts.maxTokens).toBe(EVALUATOR_MAX_OUTPUT_TOKENS);
    expect(EVALUATOR_MAX_OUTPUT_TOKENS).toBe(512);
    expect(captured[0]!.opts.timeoutMs).toBe(EVALUATOR_TIMEOUT_MS);
    expect(EVALUATOR_TIMEOUT_MS).toBe(30_000);
  });
});

// ── Uncovered branch — stale runId at run:complete ────────────────

describe("I-numbers — uncovered branch: stale runId on run:complete", () => {
  test("inFlightRunId set + run:complete with a DIFFERENT runId → still evaluates (FR-5), clears inFlightRunId, no crash", async () => {
    let evalCalls = 0;
    const h = makeHost({
      initialMessages: { c1: [{ role: "assistant", content: "still" }] },
      completeFn: async () => {
        evalCalls++;
        return {
          content: [{ type: "text", text: '{"achieved":false,"reason":"keep going"}' }],
          usage: { input: 1, output: 1 },
          stopReason: "stop",
        };
      },
    });
    armForValidator(h, "c1");
    await h.host.start();
    // Drive the stale-runId branch explicitly.
    h.host.getRecord("c1")!.inFlightRunId = "expected-run";
    h.bus.emit("run:complete", {
      run: {
        id: "different-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));

    // Per FR-5 / reviewer nit-3 simplification: every run:complete on
    // an armed conv triggers exactly one evaluator pass; inFlightRunId
    // is cleared uniformly; no double-evaluate.
    expect(evalCalls).toBe(1);
    expect(h.host.getRecord("c1")!.turnsEvaluated).toBe(1);
    // After the loop re-entered, inFlightRunId is re-armed to the new
    // continuation runId; it should NOT still equal the original
    // "expected-run" marker.
    expect(h.host.getRecord("c1")!.inFlightRunId).not.toBe("expected-run");
    expect(h.host.getRecord("c1")!.inFlightRunId).not.toBeNull();
  });
});

// ── Uncovered branch — getMessages throws on run:complete ─────────

describe("I-numbers — uncovered branch: getMessages throws → pause", () => {
  test("getMessagesFn rejects → record paused, paused card persisted, goal:update paused emitted", async () => {
    const h = makeHost({
      initialMessages: { c1: [{ role: "assistant", content: "x" }] },
    });
    armForValidator(h, "c1");
    await h.host.start();

    // Swap in a throwing getMessages by mutating the bound fn through
    // the harness's known store. The host took the fn at construct
    // time, so we re-create a host instead — simplest reliable path.
    const store = h.store;
    const bus = makeBus();
    const emitted: AgentEvents["goal:update"][] = [];
    bus.on("goal:update", (e) => emitted.push(e));
    const { executor, calls } = makeFakeExecutor();
    const host = new GoalHost({
      bus,
      executor,
      enabled: true,
      maxGoalTurns: 50,
      now: () => h.nowValue.value,
      readGoal: async (id: string) => store.persisted.get(id),
      writeGoal: async (id: string, goal: PersistedGoal) => {
        store.persisted.set(id, goal);
      },
      deleteGoal: async (id: string) => {
        store.persisted.delete(id);
      },
      scanGoalConversations: async () => [
        { id: "c1", persisted: store.persisted.get("c1")! },
      ],
      computeTokenSpend: async () => 0,
      getMessages: async () => {
        throw new Error("transcript fetch boom");
      },
      createMessage: async (
        conversationId: string,
        data: { role: string; content: string; parentMessageId?: string },
      ) => {
        const id = `row-${store.rows.length + 1}`;
        store.rows.push({
          id,
          role: data.role,
          content: data.content,
          conversationId,
          ...(data.parentMessageId ? { parentMessageId: data.parentMessageId } : {}),
        });
        return {
          id,
          conversationId,
          role: data.role,
          content: data.content,
          thinkingContent: null,
          model: null,
          provider: null,
          usage: null,
          runId: null,
          parentMessageId: data.parentMessageId ?? null,
          excluded: false,
          createdAt: new Date(),
        } as unknown as Awaited<ReturnType<typeof import("../db/queries/conversations").createMessage>>;
      },
      dequeuePending: () => undefined,
    });
    await host.start();
    host.getRecord("c1")!.inFlightRunId = "init-run";
    bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(host.getRecord("c1")?.status).toBe("paused");
    // Paused card carries the "transcript fetch failed" reason.
    const pausedRow = store.rows.find(
      (r) => r.content.includes("Goal paused") && r.content.includes("transcript fetch failed"),
    );
    expect(pausedRow).not.toBeUndefined();
    expect(emitted.some((e) => e.state === "paused")).toBe(true);
    // No streamChat re-entry happened.
    expect(calls).toHaveLength(0);
    host.stop();
  });
});

// ── parseGoalEnabled (env-flag parsing) ────────────────────────────

describe("parseGoalEnabled — EZCORP_GOAL_ENABLED parsing", () => {
  test("undefined → true (default ON)", () => {
    expect(parseGoalEnabled(undefined)).toBe(true);
  });

  test.each(["0", "false", "off", "no"])(
    'explicit disable value "%s" → false',
    (v) => {
      expect(parseGoalEnabled(v)).toBe(false);
    },
  );

  test.each(["FALSE", "Off", "NO", "0"])(
    'case-insensitive disable value "%s" → false',
    (v) => {
      expect(parseGoalEnabled(v)).toBe(false);
    },
  );

  test('value with whitespace " off " → false (trimmed)', () => {
    expect(parseGoalEnabled(" off ")).toBe(false);
  });

  test.each(["1", "true", "on", "yes", "anything-else"])(
    'enable / unknown value "%s" → true',
    (v) => {
      expect(parseGoalEnabled(v)).toBe(true);
    },
  );

  test('empty string "" → true (falls through to default-on per ?? "1" semantics)', () => {
    // Documents the actual production behavior so a future refactor
    // can't silently flip the bit. `process.env.EZCORP_GOAL_ENABLED = ""`
    // (operator deliberately blanks the var) keeps the feature ON,
    // matching every other ENV flag in this codebase.
    expect(parseGoalEnabled("")).toBe(true);
  });

  test("integration: GoalHost constructed with parsed flag honors enabled state", () => {
    _resetGoalHostSingleton();
    const bus = makeBus();
    const { executor } = makeFakeExecutor();
    const disabled = new GoalHost({
      bus,
      executor,
      enabled: parseGoalEnabled("0"),
    });
    expect(disabled.isEnabled()).toBe(false);
    const enabled = new GoalHost({
      bus,
      executor,
      enabled: parseGoalEnabled(undefined),
    });
    expect(enabled.isEnabled()).toBe(true);
  });
});
