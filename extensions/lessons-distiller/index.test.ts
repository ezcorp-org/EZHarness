/**
 * Unit tests for the bundled lessons-distiller extension.
 *
 * The runtime API is swapped out via `_setRuntimeApiForTests` so these
 * tests run without any JSON-RPC pipe / DB / LLM. The real wire path
 * (subprocess + reverse-RPC) is covered by
 * `src/__tests__/lessons-distiller-real-subprocess.e2e.test.ts`; this
 * file isolates the extension's own logic — the single `distill`
 * pipeline, its gating and cost ordering, JSON parsing, the
 * outcome-to-tool-result envelope, and the `run:complete` core.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { LlmCredentialError, LlmProviderError } from "@ezcorp/sdk/runtime";
import {
  tools,
  distill,
  distillRunComplete,
  defineDistillLoop,
  _setRuntimeApiForTests,
  _resetRuntimeApiForTests,
  _resetDistillerModelWarningForTests,
  type DistillOptions,
  type DistillerRuntimeApi,
  type DistillerEnvelope,
} from "./index";

// JSON-parsing behaviour is tested implicitly by feeding `distill`
// known LLM responses through the fake runtime API. The internal
// parser is intentionally not exported so the seam stays narrow.

interface RecordedCall {
  api: keyof DistillerRuntimeApi;
  args: unknown;
}

type FakeMessage = { id: string; role: string; content: string };
type FakeLessonRow = {
  id: string;
  slug: string;
  title: string;
  body: string;
  visibility: string;
  frontmatter?: Record<string, unknown> | null;
};
type FakeWriteResult = { lesson: FakeLessonRow | null; created: boolean };

const DEFAULT_MESSAGES: FakeMessage[] = [
  { id: "m1", role: "user", content: "hello" },
  { id: "m2", role: "assistant", content: "hi there" },
];

/** Default `distill` args — tests override only what they exercise, so
 *  the pipeline's required shape lives in exactly one place. */
function distillArgs(overrides: Partial<DistillOptions> = {}): DistillOptions {
  return {
    conversationId: "c",
    messages: DEFAULT_MESSAGES,
    skipTriggerGate: true,
    settings: {},
    projectId: "p",
    ...overrides,
  };
}

function makeFakeRuntime(overrides: Partial<DistillerRuntimeApi> = {}): {
  calls: RecordedCall[];
  api: DistillerRuntimeApi;
  setMessages(msgs: FakeMessage[]): void;
  setProjectId(projectId: string | null): void;
  setEnvelopeThrow(err: Error): void;
  setLlmContent(text: string): void;
  setTriggerGate(result: { shouldDistill: boolean; reason?: string }): void;
  setLessonsWriteResult(result: FakeWriteResult): void;
  setLessonsWriteThrow(err: Error): void;
  setLlmThrow(err: Error): void;
  setTriggerGateThrow(err: Error): void;
  state: {
    messages: FakeMessage[];
    projectId: string | null;
    envelopeThrow: Error | null;
    triggerGate: { shouldDistill: boolean; reason?: string };
    triggerGateThrow: Error | null;
    llmContent: string;
    llmThrow: Error | null;
    lessonsWriteResult: FakeWriteResult;
    lessonsWriteThrow: Error | null;
  };
} {
  const state = {
    messages: DEFAULT_MESSAGES,
    projectId: "proj-fake" as string | null,
    envelopeThrow: null as Error | null,
    triggerGate: { shouldDistill: true, reason: "trigger-fired" },
    triggerGateThrow: null as Error | null,
    llmContent: '{"slug":"sample-slug","title":"Sample title","body":"Sample body"}',
    llmThrow: null as Error | null,
    lessonsWriteResult: {
      lesson: {
        id: "lesson-1",
        slug: "sample-slug",
        title: "Sample title",
        body: "Sample body",
        visibility: "user",
      },
      created: true,
    } as FakeWriteResult,
    lessonsWriteThrow: null as Error | null,
  };
  const calls: RecordedCall[] = [];

  const api: DistillerRuntimeApi = {
    async getMessagesEnvelope(conversationId: string) {
      calls.push({ api: "getMessagesEnvelope", args: { conversationId } });
      if (state.envelopeThrow) throw state.envelopeThrow;
      return { messages: state.messages, projectId: state.projectId };
    },
    async triggerGate(params) {
      calls.push({ api: "triggerGate", args: params });
      if (state.triggerGateThrow) throw state.triggerGateThrow;
      return state.triggerGate;
    },
    async llmComplete(opts) {
      calls.push({ api: "llmComplete", args: opts });
      if (state.llmThrow) throw state.llmThrow;
      return { content: state.llmContent };
    },
    async lessonsWrite(input) {
      calls.push({ api: "lessonsWrite", args: input });
      if (state.lessonsWriteThrow) throw state.lessonsWriteThrow;
      return state.lessonsWriteResult as never;
    },
    ...overrides,
  };

  return {
    calls,
    api,
    state,
    setMessages(msgs) { state.messages = msgs; },
    setProjectId(projectId) { state.projectId = projectId; },
    setEnvelopeThrow(err) { state.envelopeThrow = err; },
    setLlmContent(text) { state.llmContent = text; },
    setTriggerGate(result) {
      // Normalize optional `reason` to satisfy the strict shape on
      // state.triggerGate (always-present `reason: string`).
      state.triggerGate = { shouldDistill: result.shouldDistill, reason: result.reason ?? "" };
    },
    setTriggerGateThrow(err) { state.triggerGateThrow = err; },
    setLessonsWriteResult(result) { state.lessonsWriteResult = result; },
    setLessonsWriteThrow(err) { state.lessonsWriteThrow = err; },
    setLlmThrow(err) { state.llmThrow = err; },
  };
}

afterEach(() => {
  _resetRuntimeApiForTests();
  _resetDistillerModelWarningForTests();
});

function parseEnvelope(text: string): DistillerEnvelope {
  return JSON.parse(text) as DistillerEnvelope;
}

/** Index of the first call to `api`, or -1. Used to assert ordering
 *  (e.g. the gate must run before anything billable). */
function callIndex(calls: RecordedCall[], api: keyof DistillerRuntimeApi): number {
  return calls.findIndex((c) => c.api === api);
}

// ─────────────────────────────────────────────────────────────────────
// distill pipeline — happy path + provider/model resolution
// ─────────────────────────────────────────────────────────────────────

describe("distill — happy path", () => {
  test("LLM returns valid envelope → lessons.write called → success outcome", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(
      distillArgs({ conversationId: "conv-1", settings: { provider: "google" }, projectId: "proj-1" }),
    );
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.lesson.slug).toBe("sample-slug");
      expect(outcome.lesson.title).toBe("Sample title");
    }
    // lessons.write was called with the parsed lesson + projectId
    const writeCall = fake.calls.find((c) => c.api === "lessonsWrite");
    expect(writeCall?.args).toMatchObject({
      slug: "sample-slug",
      title: "Sample title",
      body: "Sample body",
      projectId: "proj-1",
      visibility: "user",
    });
  });

  test("the caller's messages are what the LLM sees — no extra fetch", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(
      distillArgs({ messages: [{ id: "m9", role: "user", content: "use bun not npm" }] }),
    );
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(JSON.stringify(llmCall?.args)).toContain("use bun not npm");
    // The pipeline never re-reads the conversation itself.
    expect(fake.calls.find((c) => c.api === "getMessagesEnvelope")).toBeUndefined();
  });

  test("only the last 20 messages are sent to the LLM", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      content: `msg-${i}`,
    }));
    await distill(distillArgs({ messages: many }));
    const sent = JSON.stringify(fake.calls.find((c) => c.api === "llmComplete")?.args);
    expect(sent).toContain("msg-24");
    expect(sent).toContain("msg-5");
    expect(sent).not.toContain("msg-4");
  });

  test("provider setting overrides the default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs({ settings: { provider: "openai" } }));
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("model setting overrides the provider default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(
      distillArgs({ settings: { provider: "anthropic", model: "claude-haiku-custom" } }),
    );
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "anthropic", model: "claude-haiku-custom" });
  });

  test("blank model setting falls back to provider default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs({ settings: { provider: "anthropic", model: "" } }));
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20250514" });
  });

  test("unknown provider falls back to google", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs({ settings: { provider: "fictitious" } }));
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "google", model: "gemini-2.5-flash-lite" });
  });

  test("[N2] ollama provider resolves to gemma4:e2b default", async () => {
    // PROVIDER_DEFAULT_MODEL must resolve `provider: "ollama"` (no
    // explicit model) to `gemma4:e2b` — the locally-installed default
    // shipped by EZCorp's Ollama support. Asserting on the resolved
    // model in the LLM call args locks the default in.
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs({ settings: { provider: "ollama" } }));
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "ollama", model: "gemma4:e2b" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// LLM-empty / null / [] / {} all map to silent decline
// ─────────────────────────────────────────────────────────────────────

describe("distill — LLM declines map to llm_empty", () => {
  test('literal "EMPTY" → decline llm_empty', async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("EMPTY");
    _setRuntimeApiForTests(fake.api);

    expect(await distill(distillArgs())).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("null → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("null");
    _setRuntimeApiForTests(fake.api);

    expect(await distill(distillArgs())).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("[] → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("[]");
    _setRuntimeApiForTests(fake.api);

    expect(await distill(distillArgs())).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("{} (object missing required fields) → decline llm_malformed", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("{}");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("empty string → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("");
    _setRuntimeApiForTests(fake.api);

    expect(await distill(distillArgs())).toEqual({ kind: "decline", reason: "llm_empty" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Malformed JSON → decline llm_malformed with detail
// ─────────────────────────────────────────────────────────────────────

describe("distill — malformed JSON → decline llm_malformed", () => {
  test("non-JSON garbage", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("this is not json {oops");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
      expect((outcome as { detail?: string }).detail).toBeDefined();
    }
  });

  test("array of objects instead of single object", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent('[{"slug":"a","title":"a","body":"a"}]');
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("JSON scalar instead of an object", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("42");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
      expect((outcome as { detail?: string }).detail).toContain("number");
    }
  });

  test("JSON with missing required fields", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent('{"slug":"only-slug"}');
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("```json fenced response is unwrapped", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent('```json\n{"slug":"a","title":"b","body":"c"}\n```');
    _setRuntimeApiForTests(fake.api);

    expect((await distill(distillArgs())).kind).toBe("success");
  });

  test("frontmatter rides through to lessons.write", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent(
      '{"slug":"a","title":"b","body":"c","frontmatter":{"confidence":"high"}}',
    );
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs());
    expect(fake.calls.find((c) => c.api === "lessonsWrite")?.args).toMatchObject({
      frontmatter: { confidence: "high" },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pipeline gates: empty conversation, trigger gate, LLM + DB failures
// ─────────────────────────────────────────────────────────────────────

describe("distill — pipeline gates", () => {
  test("empty messages → decline empty_conversation; gate + LLM not called", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs({ messages: [], skipTriggerGate: false }));
    expect(outcome).toEqual({ kind: "decline", reason: "empty_conversation" });
    expect(fake.calls).toEqual([]);
  });

  test("trigger gate says no → decline trigger_gate_blocked; LLM not called", async () => {
    const fake = makeFakeRuntime();
    fake.setTriggerGate({ shouldDistill: false, reason: "no-signal" });
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs({ skipTriggerGate: false }));
    expect(outcome).toEqual({ kind: "decline", reason: "trigger_gate_blocked" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
    expect(fake.calls.find((c) => c.api === "lessonsWrite")).toBeUndefined();
  });

  test("the gate is consulted BEFORE the LLM call", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs({ skipTriggerGate: false }));
    const gateAt = callIndex(fake.calls, "triggerGate");
    const llmAt = callIndex(fake.calls, "llmComplete");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(llmAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(llmAt);
  });

  test("gate receives the run scope it was given", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(
      distillArgs({
        conversationId: "conv-7",
        skipTriggerGate: false,
        runScope: { runId: "run-7", runStartedAtMs: 1700000000000 },
      }),
    );
    expect(fake.calls.find((c) => c.api === "triggerGate")?.args).toEqual({
      conversationId: "conv-7",
      runId: "run-7",
      runStartedAtMs: 1700000000000,
    });
  });

  test("no run scope → gate gets the conversation id alone", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill(distillArgs({ conversationId: "conv-8", skipTriggerGate: false }));
    expect(fake.calls.find((c) => c.api === "triggerGate")?.args).toEqual({
      conversationId: "conv-8",
    });
  });

  test("trigger gate throws → error internal", async () => {
    const fake = makeFakeRuntime();
    fake.setTriggerGateThrow(new Error("gate RPC exploded"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs({ skipTriggerGate: false }));
    expect(outcome).toEqual({
      kind: "error",
      reason: "internal",
      detail: "gate RPC exploded",
    });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("skipTriggerGate=true bypasses the gate entirely", async () => {
    const fake = makeFakeRuntime();
    fake.setTriggerGate({ shouldDistill: false, reason: "no-signal" });
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("success");
    // triggerGate was NOT called when skipped
    expect(fake.calls.find((c) => c.api === "triggerGate")).toBeUndefined();
  });

  test("LLM throws generic → error llm_error, cause transient", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new Error("upstream 503"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error" && outcome.reason === "llm_error") {
      expect(outcome.detail).toBe("upstream 503");
      // A generic upstream error is retryable next run — not a config gate.
      expect(outcome.cause).toBe("transient");
    }
  });

  test("LLM throws LlmCredentialError → error llm_error, cause unavailable", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new LlmCredentialError("google", "no GOOGLE_API_KEY"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs({ settings: { provider: "google" } }));
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error" && outcome.reason === "llm_error") {
      // Missing credential is a deployment-config gate → fail-soft signal.
      expect(outcome.cause).toBe("unavailable");
    }
  });

  test("LLM throws LlmProviderError → error llm_error, cause unavailable", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new LlmProviderError("google", "provider not granted"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs({ settings: { provider: "google" } }));
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error" && outcome.reason === "llm_error") {
      expect(outcome.cause).toBe("unavailable");
    }
  });

  test("lessons.write throws → error db_error with detail", async () => {
    const fake = makeFakeRuntime();
    fake.setLessonsWriteThrow(new Error("DB connection lost"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill(distillArgs());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.reason).toBe("db_error");
      expect(outcome.detail).toContain("DB connection lost");
    }
  });

  test("lessons.write returns created=false → decline slug_collision", async () => {
    const fake = makeFakeRuntime();
    fake.setLessonsWriteResult({
      lesson: {
        id: "existing-id",
        slug: "duplicate-slug",
        title: "Existing",
        body: "Existing body",
        visibility: "user",
      },
      created: false,
    });
    fake.setLlmContent('{"slug":"duplicate-slug","title":"x","body":"y"}');
    _setRuntimeApiForTests(fake.api);

    expect(await distill(distillArgs())).toEqual({
      kind: "decline",
      reason: "slug_collision",
      existingSlug: "duplicate-slug",
    });
  });

  test("created=false with no returned row falls back to the parsed slug", async () => {
    const fake = makeFakeRuntime();
    fake.setLessonsWriteResult({ lesson: null, created: false });
    fake.setLlmContent('{"slug":"parsed-slug","title":"x","body":"y"}');
    _setRuntimeApiForTests(fake.api);

    expect(await distill(distillArgs())).toEqual({
      kind: "decline",
      reason: "slug_collision",
      existingSlug: "parsed-slug",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fail-soft degrade: provider/credential-class LLM failure must warn
// ONCE per process (not error-spam) and skip cleanly. Regression for
// the bundled-boot defect where the default google/gemini-2.0-flash-lite
// call error-spammed every run when no Google credential was configured.
// ─────────────────────────────────────────────────────────────────────

describe("distillRunComplete — fail-soft on unavailable model", () => {
  const RUN = { run: { id: "run-1", agentName: "chat", status: "success", startedAt: 1 } as const };
  function withCapturedWarn(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    return { warnings, restore: () => { console.warn = original; } };
  }

  test("credential-missing LLM failure warns exactly once, never error-spams", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new LlmCredentialError("google", "no GOOGLE_API_KEY"));
    _setRuntimeApiForTests(fake.api);
    const settings = { enabled: true, provider: "google", model: "" };

    const errorSpy: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errorSpy.push(args.map(String).join(" ")); };
    const cap = withCapturedWarn();
    try {
      // Three back-to-back fires — the credential is still missing each
      // time. We must warn at most once total.
      await distillRunComplete({ ...RUN, conversationId: "c1" }, settings);
      await distillRunComplete({ ...RUN, conversationId: "c2" }, settings);
      await distillRunComplete({ ...RUN, conversationId: "c3" }, settings);
    } finally {
      cap.restore();
      console.error = originalError;
    }

    expect(cap.warnings.length).toBe(1);
    expect(cap.warnings[0]).toContain("gemini-2.5-flash-lite");
    expect(cap.warnings[0]).toContain("google");
    expect(cap.warnings[0]).toContain("once per server start");
    expect(errorSpy.length).toBe(0);
  });

  test("a transient LLM failure does NOT emit the unavailable warning", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new Error("upstream 503"));
    _setRuntimeApiForTests(fake.api);

    const cap = withCapturedWarn();
    try {
      await distillRunComplete({ ...RUN, conversationId: "c1" }, { enabled: true, provider: "google", model: "" });
    } finally {
      cap.restore();
    }
    expect(cap.warnings.length).toBe(0);
  });

  test("distinct unavailable provider/model pairs each warn once", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new LlmProviderError("google", "provider not granted"));
    _setRuntimeApiForTests(fake.api);

    const cap = withCapturedWarn();
    try {
      await distillRunComplete({ ...RUN, conversationId: "c1" }, { enabled: true, provider: "google", model: "" });
      await distillRunComplete({ ...RUN, conversationId: "c2" }, { enabled: true, provider: "openai", model: "" });
    } finally {
      cap.restore();
    }
    expect(cap.warnings.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// distill_now tool dispatcher — the manual !EZ:distill path. It owns the
// conversation read (envelope) and always skips the gate.
// ─────────────────────────────────────────────────────────────────────

describe("distill_now tool", () => {
  const handler = tools.distill_now!;

  test("missing conversationId → tool error", async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("conversationId");
  });

  test("non-string conversationId → tool error", async () => {
    const result = await handler({ conversationId: 123 });
    expect(result.isError).toBe(true);
  });

  test("disabled setting → returns settings_disabled decline envelope", async () => {
    // Provide ctx.invocationMetadata.settings with enabled=false; the
    // tool reads via `getSetting(ctx, "enabled")`.
    const result = await handler(
      { conversationId: "conv-1" },
      { invocationMetadata: { settings: { enabled: false } } },
    );
    expect(result.isError).toBeFalsy();
    const env = parseEnvelope(result.content[0]!.text);
    expect(env.__ezDistillerOutcome).toBe(true);
    expect(env.outcome.kind).toBe("decline");
    if (env.outcome.kind === "decline") {
      expect(env.outcome.reason).toBe("settings_disabled");
    }
  });

  test("happy path → success envelope, one conversation read, gate skipped", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    const result = await handler(
      { conversationId: "conv-1" },
      { invocationMetadata: { settings: { enabled: true, provider: "openai", model: "" } } },
    );
    expect(result.isError).toBeFalsy();
    expect(parseEnvelope(result.content[0]!.text).outcome.kind).toBe("success");
    // Exactly one conversation read; the gate is never consulted.
    expect(fake.calls.filter((c) => c.api === "getMessagesEnvelope").length).toBe(1);
    expect(fake.calls.find((c) => c.api === "triggerGate")).toBeUndefined();
    // Settings came off ctx, not a settings RPC.
    expect(fake.calls.find((c) => c.api === "llmComplete")?.args).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    // The lesson is written against the conversation's project.
    expect(fake.calls.find((c) => c.api === "lessonsWrite")?.args).toMatchObject({
      projectId: "proj-fake",
    });
  });

  test("empty conversation → decline envelope, no LLM call", async () => {
    const fake = makeFakeRuntime();
    fake.setMessages([]);
    _setRuntimeApiForTests(fake.api);

    const result = await handler({ conversationId: "conv-1" });
    expect(result.isError).toBeFalsy();
    const env = parseEnvelope(result.content[0]!.text);
    expect(env.outcome).toEqual({ kind: "decline", reason: "empty_conversation" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("conversation read throws → internal error envelope", async () => {
    const fake = makeFakeRuntime();
    fake.setEnvelopeThrow(new Error("getMessages RPC failed"));
    _setRuntimeApiForTests(fake.api);

    const result = await handler({ conversationId: "conv-1" });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result.content[0]!.text).outcome).toEqual({
      kind: "error",
      reason: "internal",
      detail: "getMessages RPC failed",
    });
  });

  test("conversation with no projectId → internal error envelope", async () => {
    const fake = makeFakeRuntime();
    fake.setProjectId(null);
    _setRuntimeApiForTests(fake.api);

    const result = await handler({ conversationId: "conv-1" });
    expect(result.isError).toBe(true);
    expect(parseEnvelope(result.content[0]!.text).outcome).toEqual({
      kind: "error",
      reason: "internal",
      detail: "conversation has no projectId",
    });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// distillRunComplete — the auto path's shared core (settings injected by
// the loop primitive). Pins the gating contract, the single-read cost
// shape, and the run scope handed to the trigger gate.
// ─────────────────────────────────────────────────────────────────────

describe("distillRunComplete — shared settings-injected core", () => {
  const CHAT_RUN = { id: "run-1", agentName: "chat", status: "success", startedAt: 1700000000000 };

  test("settings.enabled=false → undefined (gated, no distill)", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    const out = await distillRunComplete(
      { run: CHAT_RUN, conversationId: "c1" },
      { enabled: false },
    );
    expect(out).toBeUndefined();
    // Gated fires cost NOTHING — not even a conversation read.
    expect(fake.calls).toEqual([]);
  });

  test("wrong agent → undefined (no distill)", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    expect(
      await distillRunComplete(
        { run: { ...CHAT_RUN, agentName: "team" }, conversationId: "c1" },
        { enabled: true },
      ),
    ).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  test("non-success status → undefined (no distill)", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    expect(
      await distillRunComplete(
        { run: { ...CHAT_RUN, status: "error" }, conversationId: "c1" },
        { enabled: true },
      ),
    ).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  test("missing conversationId → undefined", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    expect(await distillRunComplete({ run: CHAT_RUN }, { enabled: true })).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  test("happy path → success outcome (settings come from the caller)", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    const out = await distillRunComplete(
      { run: CHAT_RUN, conversationId: "c1" },
      { enabled: true, provider: "openai", model: "" },
    );
    expect(out?.kind).toBe("success");
    // provider override threaded through to the LLM call
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
    // The projectId from the same envelope reaches the write.
    expect(fake.calls.find((c) => c.api === "lessonsWrite")?.args).toMatchObject({
      projectId: "proj-fake",
    });
  });

  test("the conversation is fetched EXACTLY ONCE per fire", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    await distillRunComplete({ run: CHAT_RUN, conversationId: "c1" }, { enabled: true });
    expect(fake.calls.filter((c) => c.api === "getMessagesEnvelope").length).toBe(1);
  });

  test("the gate runs before the LLM, and after the single read", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    await distillRunComplete({ run: CHAT_RUN, conversationId: "c1" }, { enabled: true });
    expect(fake.calls.map((c) => c.api)).toEqual([
      "getMessagesEnvelope",
      "triggerGate",
      "llmComplete",
      "lessonsWrite",
    ]);
  });

  test("a gate-rejected fire costs one read and NO LLM call", async () => {
    const fake = makeFakeRuntime();
    fake.setTriggerGate({ shouldDistill: false, reason: "no-signal" });
    _setRuntimeApiForTests(fake.api);

    const out = await distillRunComplete(
      { run: CHAT_RUN, conversationId: "c1" },
      { enabled: true },
    );
    expect(out).toEqual({ kind: "decline", reason: "trigger_gate_blocked" });
    expect(fake.calls.map((c) => c.api)).toEqual(["getMessagesEnvelope", "triggerGate"]);
  });

  test("the run scope from the payload is forwarded to the gate", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    await distillRunComplete(
      { run: { id: "run-42", agentName: "chat", status: "success", startedAt: 1234567890 }, conversationId: "c1" },
      { enabled: true },
    );
    expect(fake.calls.find((c) => c.api === "triggerGate")?.args).toEqual({
      conversationId: "c1",
      runId: "run-42",
      runStartedAtMs: 1234567890,
    });
  });

  test("a payload without id/startedAt sends the conversation id alone", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    await distillRunComplete(
      { run: { agentName: "chat", status: "success" }, conversationId: "c1" },
      { enabled: true },
    );
    expect(fake.calls.find((c) => c.api === "triggerGate")?.args).toEqual({
      conversationId: "c1",
    });
  });

  test("conversation unwired (-32604) → undefined, fail-soft", async () => {
    const { JsonRpcError } = await import("@ezcorp/sdk/runtime");
    const fake = makeFakeRuntime();
    fake.setEnvelopeThrow(new JsonRpcError(-32604, "not wired"));
    _setRuntimeApiForTests(fake.api);
    expect(
      await distillRunComplete({ run: CHAT_RUN, conversationId: "c1" }, { enabled: true }),
    ).toBeUndefined();
  });

  test("an unexpected read failure warns and skips (never throws)", async () => {
    const fake = makeFakeRuntime();
    fake.setEnvelopeThrow(new Error("boom"));
    _setRuntimeApiForTests(fake.api);

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      expect(
        await distillRunComplete({ run: CHAT_RUN, conversationId: "c1" }, { enabled: true }),
      ).toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("getMessagesEnvelope failed");
  });

  test("conversation with no projectId → undefined, nothing billable runs", async () => {
    const fake = makeFakeRuntime();
    fake.setProjectId(null);
    _setRuntimeApiForTests(fake.api);
    expect(
      await distillRunComplete({ run: CHAT_RUN, conversationId: "c1" }, { enabled: true }),
    ).toBeUndefined();
    expect(fake.calls.map((c) => c.api)).toEqual(["getMessagesEnvelope"]);
  });
});

describe("defineDistillLoop — registration", () => {
  test("registers the run:complete capture loop without throwing", () => {
    // Tests run with `import.meta.main` false, so the boot wiring never
    // ran — registering once here is safe (no duplicate-id collision).
    expect(() => defineDistillLoop()).not.toThrow();
  });
});
