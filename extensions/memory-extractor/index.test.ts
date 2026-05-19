/**
 * Unit tests for the bundled memory-extractor extension.
 *
 * The runtime API is swapped out via `_setRuntimeApiForTests` so these
 * tests run without any JSON-RPC pipe / DB / LLM. The host-side
 * pipeline is exercised by the parity test
 * (`src/__tests__/memory-extractor-port-parity.test.ts`); this file
 * isolates the extension's own logic — JSON parsing, settings
 * gating, the `run:complete` handler shape, the compaction tick.
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
  handleRunComplete,
  handleCompactionTick,
  extract,
  EXTRACTION_SYSTEM_PROMPT,
  resolveCompactionCron,
  SUPPORTED_COMPACTION_CRONS,
  DEFAULT_COMPACTION_CRON,
  _setRuntimeApiForTests,
  _resetRuntimeApiForTests,
  type MemoryExtractorRuntimeApi,
} from "./index";
import manifestConfig from "./ezcorp.config";

interface RecordedCall {
  api: keyof MemoryExtractorRuntimeApi;
  args: unknown;
}

function makeFakeRuntime(overrides: Partial<MemoryExtractorRuntimeApi> = {}): {
  calls: RecordedCall[];
  api: MemoryExtractorRuntimeApi;
  setMessages(msgs: { id: string; role: string; content: string }[]): void;
  setLlmContent(text: string): void;
  setSettings(values: Record<string, unknown>): void;
  setLlmThrow(err: Error): void;
  setDedupResult(result: { action: "inserted" | "updated"; memoryId: string }): void;
  setDedupSequence(results: Array<{ action: "inserted" | "updated"; memoryId: string }>): void;
  setCompactResult(result: { mergedCount: number }): void;
  state: {
    messages: { id: string; role: string; content: string }[];
    projectId: string | null;
    llmContent: string;
    llmThrow: Error | null;
    settings: Record<string, unknown>;
    dedupResult: { action: "inserted" | "updated"; memoryId: string };
    dedupSequence: Array<{ action: "inserted" | "updated"; memoryId: string }> | null;
    dedupCallIndex: number;
    compactResult: { mergedCount: number };
  };
} {
  const state = {
    messages: [
      { id: "m1", role: "user", content: "I prefer TypeScript" },
      { id: "m2", role: "assistant", content: "Got it." },
    ],
    projectId: "proj-fake" as string | null,
    llmContent:
      '[{"content":"User prefers TypeScript","category":"preferences","confidence":"high","messageIds":["m1"]}]',
    llmThrow: null as Error | null,
    settings: { enabled: true } as Record<string, unknown>,
    dedupResult: { action: "inserted", memoryId: "mem-1" } as {
      action: "inserted" | "updated";
      memoryId: string;
    },
    dedupSequence: null as Array<{ action: "inserted" | "updated"; memoryId: string }> | null,
    dedupCallIndex: 0,
    compactResult: { mergedCount: 0 },
  };
  const calls: RecordedCall[] = [];

  const api: MemoryExtractorRuntimeApi = {
    async getMessagesEnvelope(conversationId: string) {
      calls.push({ api: "getMessagesEnvelope", args: { conversationId } });
      return { messages: state.messages, projectId: state.projectId };
    },
    async llmComplete(opts) {
      calls.push({ api: "llmComplete", args: opts });
      if (state.llmThrow) throw state.llmThrow;
      return { content: state.llmContent };
    },
    async dedupMemoryWrite(input) {
      calls.push({ api: "dedupMemoryWrite", args: input });
      if (state.dedupSequence) {
        const result = state.dedupSequence[state.dedupCallIndex];
        state.dedupCallIndex += 1;
        return result ?? { action: "inserted", memoryId: `mem-${state.dedupCallIndex}` };
      }
      return state.dedupResult;
    },
    async compact(args) {
      calls.push({ api: "compact", args });
      return state.compactResult;
    },
    async getMySettings() {
      calls.push({ api: "getMySettings", args: {} });
      return state.settings;
    },
    ...overrides,
  };

  return {
    calls,
    api,
    state,
    setMessages(msgs) { state.messages = msgs; },
    setLlmContent(text) { state.llmContent = text; },
    setSettings(values) { state.settings = values; },
    setLlmThrow(err) { state.llmThrow = err; },
    setDedupResult(result) { state.dedupResult = result; },
    setDedupSequence(results) {
      state.dedupSequence = results;
      state.dedupCallIndex = 0;
    },
    setCompactResult(result) { state.compactResult = result; },
  };
}

afterEach(() => {
  _resetRuntimeApiForTests();
});

// ─────────────────────────────────────────────────────────────────────
// extract — happy path: N memories
// ─────────────────────────────────────────────────────────────────────

describe("extract — happy path", () => {
  test("LLM returns array of facts → dedupMemoryWrite called per fact → success outcome", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent(
      '[{"content":"User prefers TypeScript","category":"preferences","confidence":"high","messageIds":["m1"]},{"content":"User builds healthcare SaaS","category":"biographical","confidence":"medium","messageIds":["m2"]}]',
    );
    fake.setDedupSequence([
      { action: "inserted", memoryId: "mem-1" },
      { action: "inserted", memoryId: "mem-2" },
    ]);
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "conv-1",
      settings: { provider: "google" },
      projectId: "proj-1",
    });

    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.writes).toHaveLength(2);
      expect(outcome.writes[0]!.fact.content).toBe("User prefers TypeScript");
      expect(outcome.writes[0]!.fact.category).toBe("preferences");
      expect(outcome.writes[0]!.action).toBe("inserted");
      expect(outcome.writes[1]!.fact.category).toBe("biographical");
    }
    const writeCalls = fake.calls.filter((c) => c.api === "dedupMemoryWrite");
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0]!.args).toMatchObject({
      content: "User prefers TypeScript",
      category: "preferences",
      conversationId: "conv-1",
      projectId: "proj-fake",
      extensionId: "memory-extractor",
    });
  });

  test("provider setting overrides the default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await extract({
      conversationId: "conv-1",
      settings: { provider: "anthropic" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5-20250514",
    });
  });

  test("model override wins over provider default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await extract({
      conversationId: "conv-1",
      settings: { provider: "openai", model: "gpt-4o-custom" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "openai", model: "gpt-4o-custom" });
  });

  test("unknown provider falls back to google", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await extract({
      conversationId: "conv-1",
      settings: { provider: "fictitious" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "google", model: "gemini-2.0-flash-lite" });
  });

  test("[N2] ollama provider resolves to gemma4:e2b default", async () => {
    // Mirror of the lessons-distiller N2 guard. PROVIDER_DEFAULT_MODEL
    // must resolve `provider: "ollama"` (no explicit model) to
    // `gemma4:e2b` — the locally-installed default shipped by EZCorp's
    // Ollama support.
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await extract({
      conversationId: "conv-1",
      settings: { provider: "ollama" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "ollama", model: "gemma4:e2b" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// extract — decline branches
// ─────────────────────────────────────────────────────────────────────

describe("extract — decline branches", () => {
  test("empty messages → decline empty_conversation; LLM not called", async () => {
    const fake = makeFakeRuntime();
    fake.setMessages([]);
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "empty_conversation" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("LLM returns [] → success with no writes (zero-fact run)", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("[]");
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.writes).toHaveLength(0);
    }
    expect(fake.calls.find((c) => c.api === "dedupMemoryWrite")).toBeUndefined();
  });

  test("LLM returns empty string → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("");
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("LLM returns non-array JSON → decline llm_malformed", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent('{"oops":"object not array"}');
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("LLM returns garbage → decline llm_malformed with detail", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("this is not json {oops");
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
      expect((outcome as { detail?: string }).detail).toBeDefined();
    }
  });

  test("```json fenced response is unwrapped", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent(
      '```json\n[{"content":"unwrapped fact","category":"technical","messageIds":["m1"]}]\n```',
    );
    fake.setDedupSequence([{ action: "inserted", memoryId: "mem-fenced" }]);
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.writes).toHaveLength(1);
    }
  });

  test("entries with bad category are filtered", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent(
      '[{"content":"good","category":"preferences"},{"content":"bad","category":"madeupcategory"}]',
    );
    fake.setDedupSequence([{ action: "inserted", memoryId: "mem-good" }]);
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.writes).toHaveLength(1);
      expect(outcome.writes[0]!.fact.content).toBe("good");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// extract — error branches
// ─────────────────────────────────────────────────────────────────────

describe("extract — error branches", () => {
  test("LLM throws → error llm_error with detail", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new Error("upstream 503"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.reason).toBe("llm_error");
      expect(outcome.detail).toBe("upstream 503");
    }
  });

  test("getMessagesEnvelope throws → error internal", async () => {
    const fake = makeFakeRuntime({
      async getMessagesEnvelope() {
        throw new Error("conn lost");
      },
    });
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.reason).toBe("internal");
      expect(outcome.detail).toContain("conn lost");
    }
  });

  test("dedup throws on one fact → other facts still write (per-fact resilience)", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent(
      '[{"content":"first","category":"preferences"},{"content":"second","category":"technical"}]',
    );
    let callCount = 0;
    fake.api.dedupMemoryWrite = async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("DB blip");
      return { action: "inserted", memoryId: "mem-2" };
    };
    _setRuntimeApiForTests(fake.api);

    const outcome = await extract({
      conversationId: "c", settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      // Only the second write succeeded; first was logged + dropped.
      expect(outcome.writes).toHaveLength(1);
      expect(outcome.writes[0]!.fact.content).toBe("second");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// handleRunComplete — event handler gating
// ─────────────────────────────────────────────────────────────────────

describe("handleRunComplete — event handler", () => {
  test("ignored when settings.enabled is false", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: false });
    _setRuntimeApiForTests(fake.api);

    const out = await handleRunComplete({
      run: { agentName: "chat", status: "success" },
      conversationId: "conv-1",
    });

    expect(out).toEqual({ kind: "decline", reason: "settings_disabled" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("ignored when run.agentName !== 'chat'", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const out = await handleRunComplete({
      run: { agentName: "team-handoff", status: "success" },
      conversationId: "conv-1",
    });

    expect(out).toEqual({ kind: "decline", reason: "wrong_agent_or_status" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("ignored when run.status !== 'success'", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const out = await handleRunComplete({
      run: { agentName: "chat", status: "error" },
      conversationId: "conv-1",
    });

    expect(out).toEqual({ kind: "decline", reason: "wrong_agent_or_status" });
  });

  test("ignored when conversationId missing", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const out = await handleRunComplete({
      run: { agentName: "chat", status: "success" },
    });
    expect(out).toBeUndefined();
  });

  test("settings throw → defaults to enabled (does not crash)", async () => {
    const fake = makeFakeRuntime({
      async getMySettings() {
        throw new Error("network blip");
      },
    });
    _setRuntimeApiForTests(fake.api);

    const out = await handleRunComplete({
      run: { agentName: "chat", status: "success" },
      conversationId: "conv-1",
    });
    // Even when getMySettings fails the run should not throw; the
    // listener contract is fire-and-forget. The handler still passes
    // through to extract() which returns a success outcome.
    expect(out).toBeDefined();
  });

  test("happy path: chat run + enabled → extracts memories", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const out = await handleRunComplete({
      run: { agentName: "chat", status: "success" },
      conversationId: "conv-1",
    });
    expect(out?.kind).toBe("success");
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeDefined();
    expect(fake.calls.find((c) => c.api === "dedupMemoryWrite")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// handleCompactionTick — schedule handler
// ─────────────────────────────────────────────────────────────────────

describe("handleCompactionTick — schedule handler", () => {
  test("happy path: settings enabled → calls runtime.memory.compact", async () => {
    const fake = makeFakeRuntime();
    fake.setCompactResult({ mergedCount: 7 });
    _setRuntimeApiForTests(fake.api);

    const out = await handleCompactionTick();
    expect(out).toEqual({ mergedCount: 7 });
    const compactCall = fake.calls.find((c) => c.api === "compact");
    expect(compactCall).toBeDefined();
  });

  test("compaction_enabled=false → skipped: settings_disabled", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: true, compaction_enabled: false });
    _setRuntimeApiForTests(fake.api);

    const out = await handleCompactionTick();
    expect(out).toEqual({ skipped: true, reason: "settings_disabled" });
    expect(fake.calls.find((c) => c.api === "compact")).toBeUndefined();
  });

  test("master enabled=false → skipped: extractor_disabled", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: false });
    _setRuntimeApiForTests(fake.api);

    const out = await handleCompactionTick();
    expect(out).toEqual({ skipped: true, reason: "extractor_disabled" });
  });

  test("compact throws → skipped: internal_error (no crash)", async () => {
    const fake = makeFakeRuntime({
      async compact() {
        throw new Error("compaction explosion");
      },
    });
    _setRuntimeApiForTests(fake.api);

    const out = await handleCompactionTick();
    expect(out).toEqual({ skipped: true, reason: "internal_error" });
  });

  test("settings throw → defaults to enabled and proceeds", async () => {
    const fake = makeFakeRuntime({
      async getMySettings() {
        throw new Error("can't read");
      },
    });
    _setRuntimeApiForTests(fake.api);

    const out = await handleCompactionTick();
    expect(out).toEqual({ mergedCount: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression pins — prompt contents + manifest selfOnly flag.
//
// These tests pin invariants that aren't covered by the behavior-driven
// tests above. They exist to flag silent regressions when:
//   1) someone tweaks EXTRACTION_SYSTEM_PROMPT to "improve" LLM output
//      and accidentally drops a category / confidence level / guardrail
//   2) someone edits ezcorp.config.ts and flips selfOnly to true; the
//      dedup tests would still pass because they bypass the manifest
//      clamp by calling the helper directly.
//
// Replaces coverage from the deleted src/__tests__/memory-extraction-
// helpers.test.ts (commit 6875600 → c3b14a4) for the prompt; adds new
// coverage for the manifest flag.
// ─────────────────────────────────────────────────────────────────────

describe("EXTRACTION_SYSTEM_PROMPT — pinned contents", () => {
  test("names all four memory categories", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("preferences");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("biographical");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("technical");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("decisions_goals");
  });

  test("names all three confidence levels", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("high");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("medium");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("low");
  });

  test("requests JSON array output with empty-array escape hatch", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("JSON array");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("[]");
  });

  test("includes Do-NOT guardrail directive", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("Do NOT");
  });

  test("includes messageIds field instruction", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("messageIds");
  });
});

describe("manifest — cross-extension memory dedup invariant", () => {
  // memory-extractor is the ONLY bundled extension granted
  // permissions.memory.selfOnly = false. This is intentional — the
  // extractor must dedup against memories authored by the legacy host
  // pipeline (and any future first-party extractor); without
  // cross-extension visibility, every extension would re-extract the
  // same fact and the table would fill with near-duplicates. Flipping
  // this flag would break dedup silently because the dedup helper
  // tests bypass the manifest clamp.
  test("permissions.memory.selfOnly is false", () => {
    expect(manifestConfig.permissions?.memory?.selfOnly).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// v1.4 — `compaction_interval_hours` cron derivation.
//
// `resolveCompactionCron` is pure; the manifest declares the legal
// crons; the SDK's `Schedule.on()` would silently drop any cron not
// declared. These tests pin every supported value + the fallback
// branches so a future widening (or accidental narrowing) of the
// allowed set can't silently misregister the cron.
// ─────────────────────────────────────────────────────────────────────

describe("resolveCompactionCron — supported cadences", () => {
  test("string '1' → every-1h cron, no fallback", () => {
    const out = resolveCompactionCron("1");
    expect(out.cron).toBe("0 */1 * * *");
    expect(out.usedFallback).toBe(false);
    expect(out.resolvedFrom).toBe("1");
  });

  test("string '3' → every-3h cron, no fallback", () => {
    const out = resolveCompactionCron("3");
    expect(out.cron).toBe("0 */3 * * *");
    expect(out.usedFallback).toBe(false);
  });

  test("string '6' (default) → every-6h cron, no fallback", () => {
    const out = resolveCompactionCron("6");
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.cron).toBe("0 */6 * * *");
    expect(out.usedFallback).toBe(false);
  });

  test("string '12' → every-12h cron, no fallback", () => {
    const out = resolveCompactionCron("12");
    expect(out.cron).toBe("0 */12 * * *");
    expect(out.usedFallback).toBe(false);
  });

  test("string '24' → daily cron, no fallback", () => {
    const out = resolveCompactionCron("24");
    expect(out.cron).toBe("0 0 * * *");
    expect(out.usedFallback).toBe(false);
  });

  test("number marshaling: numeric 6 → same cron as string '6'", () => {
    // The SchemaForm widget may serialize select values as numbers
    // depending on the storage path. The resolver normalizes both.
    const fromNumber = resolveCompactionCron(6);
    const fromString = resolveCompactionCron("6");
    expect(fromNumber.cron).toBe(fromString.cron);
    expect(fromNumber.usedFallback).toBe(false);
  });

  test("number marshaling: floor applied to non-integer numbers", () => {
    // 6.7 floors to 6, hits the supported set. No assertion on the
    // realism of the value — just locking the floor behavior.
    const out = resolveCompactionCron(6.7);
    expect(out.cron).toBe("0 */6 * * *");
    expect(out.usedFallback).toBe(false);
    expect(out.resolvedFrom).toBe("6");
  });
});

describe("resolveCompactionCron — fallback branches", () => {
  test("undefined setting → default 6h, fallback flagged", () => {
    const out = resolveCompactionCron(undefined);
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.usedFallback).toBe(true);
    expect(out.resolvedFrom).toBe("missing-or-invalid-type");
  });

  test("null setting → default 6h, fallback flagged", () => {
    const out = resolveCompactionCron(null);
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.usedFallback).toBe(true);
  });

  test("unsupported string '2' → default 6h, fallback flagged with the rejected value", () => {
    const out = resolveCompactionCron("2");
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.usedFallback).toBe(true);
    expect(out.resolvedFrom).toBe("2");
  });

  test("unsupported number 168 (legacy max) → default 6h, fallback flagged", () => {
    // The original spec called for [1..168] integer range but the
    // architecture's "manifest must declare cron" gate narrows v1.4
    // to {1, 3, 6, 12, 24}. 168 is the v1.5+ surface; today it
    // safely falls back rather than silently registering nothing.
    const out = resolveCompactionCron(168);
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.usedFallback).toBe(true);
  });

  test("zero → default 6h fallback (degenerate cron prevented)", () => {
    const out = resolveCompactionCron(0);
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.usedFallback).toBe(true);
  });

  test("negative number → default 6h fallback", () => {
    const out = resolveCompactionCron(-5);
    expect(out.cron).toBe(DEFAULT_COMPACTION_CRON);
    expect(out.usedFallback).toBe(true);
  });

  test("NaN / Infinity → default 6h fallback", () => {
    expect(resolveCompactionCron(Number.NaN).usedFallback).toBe(true);
    expect(resolveCompactionCron(Number.POSITIVE_INFINITY).usedFallback).toBe(true);
  });

  test("non-numeric, non-string types → default 6h fallback", () => {
    expect(resolveCompactionCron(true).usedFallback).toBe(true);
    expect(resolveCompactionCron({}).usedFallback).toBe(true);
    expect(resolveCompactionCron([]).usedFallback).toBe(true);
  });
});

describe("SUPPORTED_COMPACTION_CRONS — manifest parity", () => {
  test("every supported cron is declared in the manifest", () => {
    // The SDK silently drops `Schedule.on()` for crons not declared
    // in `permissions.schedule.crons`. If someone adds a value to
    // SUPPORTED_COMPACTION_CRONS without updating the manifest, the
    // user's chosen cadence would silently never fire — this test
    // is the early-warning signal.
    const declaredCrons = manifestConfig.permissions?.schedule?.crons ?? [];
    for (const cron of Object.values(SUPPORTED_COMPACTION_CRONS)) {
      expect(declaredCrons).toContain(cron);
    }
  });

  test("manifest's setting `options[]` matches SUPPORTED_COMPACTION_CRONS keys", () => {
    // Same invariant from the other direction: the user-visible
    // select widget's options list must align with the resolver's
    // accepted keys. A divergence would let the UI offer a cadence
    // the resolver doesn't recognize → silent fallback to 6h.
    const settings = manifestConfig.settings as
      | Record<string, { type?: string; options?: { value: string }[] }>
      | undefined;
    const compactionSetting = settings?.compaction_interval_hours;
    expect(compactionSetting).toBeDefined();
    expect(compactionSetting?.type).toBe("select");
    const optionValues = (compactionSetting?.options ?? []).map((o) => o.value);
    expect(optionValues.sort()).toEqual(
      Object.keys(SUPPORTED_COMPACTION_CRONS).sort(),
    );
  });
});
