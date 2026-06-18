/**
 * Unit tests for the bundled lessons-distiller extension.
 *
 * The runtime API is swapped out via `_setRuntimeApiForTests` so these
 * tests run without any JSON-RPC pipe / DB / LLM. The host-side
 * pipeline is exercised by the parity test
 * (`src/__tests__/distiller-port-parity.test.ts`); this file isolates
 * the extension's own logic — JSON parsing, settings gating, the
 * outcome-to-tool-result envelope, the `run:complete` handler shape.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { LlmCredentialError, LlmProviderError } from "@ezcorp/sdk/runtime";
import {
  tools,
  handleRunComplete,
  distill,
  distillRunComplete,
  defineDistillLoop,
  _setRuntimeApiForTests,
  _resetRuntimeApiForTests,
  _resetDistillerModelWarningForTests,
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

function makeFakeRuntime(overrides: Partial<DistillerRuntimeApi> = {}): {
  calls: RecordedCall[];
  api: DistillerRuntimeApi;
  setMessages(msgs: { id: string; role: string; content: string }[]): void;
  setLlmContent(text: string): void;
  setTriggerGate(result: { shouldDistill: boolean; reason?: string }): void;
  setSettings(values: Record<string, unknown>): void;
  setLessonsWriteResult(result: { lesson: { id: string; slug: string; title: string; body: string; visibility: string; frontmatter?: Record<string, unknown> | null } | null; created: boolean }): void;
  setLessonsWriteThrow(err: Error): void;
  setLlmThrow(err: Error): void;
  state: {
    messages: { id: string; role: string; content: string }[];
    triggerGate: { shouldDistill: boolean; reason?: string };
    llmContent: string;
    llmThrow: Error | null;
    settings: Record<string, unknown>;
    lessonsWriteResult: { lesson: { id: string; slug: string; title: string; body: string; visibility: string; frontmatter?: Record<string, unknown> | null } | null; created: boolean };
    lessonsWriteThrow: Error | null;
  };
} {
  const state = {
    messages: [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi there" },
    ],
    triggerGate: { shouldDistill: true, reason: "trigger-fired" },
    llmContent: '{"slug":"sample-slug","title":"Sample title","body":"Sample body"}',
    llmThrow: null as Error | null,
    settings: {} as Record<string, unknown>,
    lessonsWriteResult: {
      lesson: {
        id: "lesson-1",
        slug: "sample-slug",
        title: "Sample title",
        body: "Sample body",
        visibility: "user",
      },
      created: true,
    } as { lesson: { id: string; slug: string; title: string; body: string; visibility: string; frontmatter?: Record<string, unknown> | null } | null; created: boolean },
    lessonsWriteThrow: null as Error | null,
  };
  const calls: RecordedCall[] = [];

  const api: DistillerRuntimeApi = {
    async getMessages(conversationId: string) {
      calls.push({ api: "getMessages", args: { conversationId } });
      return state.messages;
    },
    async getMessagesEnvelope(conversationId: string) {
      calls.push({ api: "getMessagesEnvelope", args: { conversationId } });
      return { messages: state.messages, projectId: "proj-fake" };
    },
    async triggerGate(conversationId: string) {
      calls.push({ api: "triggerGate", args: { conversationId } });
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
    setTriggerGate(result) {
      // Normalize optional `reason` to satisfy the strict shape on
      // state.triggerGate (always-present `reason: string`).
      state.triggerGate = { shouldDistill: result.shouldDistill, reason: result.reason ?? "" };
    },
    setSettings(values) { state.settings = values; },
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

// ─────────────────────────────────────────────────────────────────────
// distill_now tool — happy path + decline + error variants
// ─────────────────────────────────────────────────────────────────────

describe("distill_now — happy path", () => {
  test("LLM returns valid envelope → lessons.write called → success outcome", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: true, provider: "google", model: "" });
    // Embed projectId in the messages getter (matches real RPC shape):
    // tool path uses `invoke(...)` directly which we can't intercept
    // without the channel. Use a lighter override: the tool resolves
    // projectId via a second invoke call. To bypass the channel we
    // override only the methods on `runtimeApi` — but the tool's
    // `invoke(...)` call for projectId is direct, not via runtimeApi.
    // We sidestep that by going through the `distill` function directly,
    // which IS fully wired through runtimeApi — covers the same logic.
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "conv-1",
      skipTriggerGate: true,
      settings: { provider: "google" },
      projectId: "proj-1",
    });
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

  test("provider setting overrides the default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill({
      conversationId: "conv-1",
      skipTriggerGate: true,
      settings: { provider: "openai" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("model setting overrides the provider default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill({
      conversationId: "conv-1",
      skipTriggerGate: true,
      settings: { provider: "anthropic", model: "claude-haiku-custom" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "anthropic", model: "claude-haiku-custom" });
  });

  test("blank model setting falls back to provider default", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill({
      conversationId: "conv-1",
      skipTriggerGate: true,
      settings: { provider: "anthropic", model: "" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20250514" });
  });

  test("unknown provider falls back to google", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill({
      conversationId: "conv-1",
      skipTriggerGate: true,
      settings: { provider: "fictitious" },
      projectId: "proj-1",
    });
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "google", model: "gemini-2.0-flash-lite" });
  });

  test("[N2] ollama provider resolves to gemma4:e2b default", async () => {
    // PROVIDER_DEFAULT_MODEL must resolve `provider: "ollama"` (no
    // explicit model) to `gemma4:e2b` — the locally-installed default
    // shipped by EZCorp's Ollama support. Asserting on the resolved
    // model in the LLM call args locks the default in.
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);

    await distill({
      conversationId: "conv-1",
      skipTriggerGate: true,
      settings: { provider: "ollama" },
      projectId: "proj-1",
    });
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

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("null → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("null");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("[] → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("[]");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "llm_empty" });
  });

  test("{} (object missing required fields) → decline llm_malformed", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("{}");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("empty string → decline llm_empty", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent("");
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "llm_empty" });
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

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
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

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("JSON with missing required fields", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent('{"slug":"only-slug"}');
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("decline");
    if (outcome.kind === "decline") {
      expect(outcome.reason).toBe("llm_malformed");
    }
  });

  test("```json fenced response is unwrapped", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmContent('```json\n{"slug":"a","title":"b","body":"c"}\n```');
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("success");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Empty conversation → decline empty_conversation
// Trigger gate blocked → decline trigger_gate_blocked
// LLM throws → error llm_error
// ─────────────────────────────────────────────────────────────────────

describe("distill — pipeline gates", () => {
  test("empty messages → decline empty_conversation; LLM not called", async () => {
    const fake = makeFakeRuntime();
    fake.setMessages([]);
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "empty_conversation" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("trigger gate says no → decline trigger_gate_blocked; LLM not called", async () => {
    const fake = makeFakeRuntime();
    fake.setTriggerGate({ shouldDistill: false, reason: "no-signal" });
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: false, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({ kind: "decline", reason: "trigger_gate_blocked" });
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("skipTriggerGate=true bypasses the gate entirely", async () => {
    const fake = makeFakeRuntime();
    fake.setTriggerGate({ shouldDistill: false, reason: "no-signal" });
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome.kind).toBe("success");
    // triggerGate was NOT called when skipped
    expect(fake.calls.find((c) => c.api === "triggerGate")).toBeUndefined();
  });

  test("LLM throws generic → error llm_error, cause transient", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new Error("upstream 503"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
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

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: { provider: "google" }, projectId: "p",
    });
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

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: { provider: "google" }, projectId: "p",
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error" && outcome.reason === "llm_error") {
      expect(outcome.cause).toBe("unavailable");
    }
  });

  test("lessons.write throws → error db_error with detail", async () => {
    const fake = makeFakeRuntime();
    fake.setLessonsWriteThrow(new Error("DB connection lost"));
    _setRuntimeApiForTests(fake.api);

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
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

    const outcome = await distill({
      conversationId: "c", skipTriggerGate: true, settings: {}, projectId: "p",
    });
    expect(outcome).toEqual({
      kind: "decline",
      reason: "slug_collision",
      existingSlug: "duplicate-slug",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// run:complete event handler
// ─────────────────────────────────────────────────────────────────────

describe("handleRunComplete — event handler", () => {
  test("ignored when settings.enabled is false", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: false });
    _setRuntimeApiForTests(fake.api);

    await handleRunComplete({
      run: { agentName: "chat", status: "success" },
      conversationId: "conv-1",
    });

    expect(fake.calls.find((c) => c.api === "getMessages")).toBeUndefined();
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("ignored when run.agentName !== 'chat'", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: true });
    _setRuntimeApiForTests(fake.api);

    await handleRunComplete({
      run: { agentName: "team-handoff", status: "success" },
      conversationId: "conv-1",
    });

    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("ignored when run.status !== 'success'", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: true });
    _setRuntimeApiForTests(fake.api);

    await handleRunComplete({
      run: { agentName: "chat", status: "error" },
      conversationId: "conv-1",
    });

    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("ignored when conversationId missing", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: true });
    _setRuntimeApiForTests(fake.api);

    await handleRunComplete({
      run: { agentName: "chat", status: "success" },
    });

    expect(fake.calls.find((c) => c.api === "getMySettings")).toBeUndefined();
  });

  test("settings missing/getter throws → defaults to enabled (does not crash)", async () => {
    const fake = makeFakeRuntime({
      async getMySettings() {
        throw new Error("network blip");
      },
    });
    _setRuntimeApiForTests(fake.api);

    // Even when getMySettings fails the run should not throw; the
    // listener contract is fire-and-forget.
    const out = await handleRunComplete({
      run: { agentName: "chat", status: "success" },
      conversationId: "conv-1",
    });
    expect(out).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fail-soft degrade: provider/credential-class LLM failure must warn
// ONCE per process (not error-spam) and skip cleanly. Regression for
// the bundled-boot defect where the default google/gemini-2.0-flash-lite
// call error-spammed every run when no Google credential was configured.
// ─────────────────────────────────────────────────────────────────────

describe("handleRunComplete — fail-soft on unavailable model", () => {
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
    fake.setSettings({ enabled: true, provider: "google", model: "" });
    fake.setLlmThrow(new LlmCredentialError("google", "no GOOGLE_API_KEY"));
    _setRuntimeApiForTests(fake.api);

    const errorSpy: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errorSpy.push(args.map(String).join(" ")); };
    const cap = withCapturedWarn();
    try {
      // Three back-to-back run:completes — the credential is still
      // missing each time. We must warn at most once total.
      await handleRunComplete({ run: { agentName: "chat", status: "success" }, conversationId: "c1" });
      await handleRunComplete({ run: { agentName: "chat", status: "success" }, conversationId: "c2" });
      await handleRunComplete({ run: { agentName: "chat", status: "success" }, conversationId: "c3" });
    } finally {
      cap.restore();
      console.error = originalError;
    }

    // Exactly one warn, mentioning the model + how to fix; zero errors.
    expect(cap.warnings.length).toBe(1);
    expect(cap.warnings[0]).toContain("gemini-2.0-flash-lite");
    expect(cap.warnings[0]).toContain("google");
    expect(cap.warnings[0]).toContain("once per server start");
    expect(errorSpy.length).toBe(0);
  });

  test("a transient LLM failure does NOT emit the unavailable warning", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({ enabled: true, provider: "google", model: "" });
    fake.setLlmThrow(new Error("upstream 503"));
    _setRuntimeApiForTests(fake.api);

    const cap = withCapturedWarn();
    try {
      await handleRunComplete({ run: { agentName: "chat", status: "success" }, conversationId: "c1" });
    } finally {
      cap.restore();
    }

    // Transient errors are retryable — no startup-style warning.
    expect(cap.warnings.length).toBe(0);
  });

  test("distinct unavailable provider/model pairs each warn once", async () => {
    const fake = makeFakeRuntime();
    fake.setLlmThrow(new LlmProviderError("google", "provider not granted"));
    _setRuntimeApiForTests(fake.api);

    const cap = withCapturedWarn();
    try {
      // google/gemini default, then openai/gpt-4o-mini — two distinct keys.
      fake.setSettings({ enabled: true, provider: "google", model: "" });
      await handleRunComplete({ run: { agentName: "chat", status: "success" }, conversationId: "c1" });
      fake.setSettings({ enabled: true, provider: "openai", model: "" });
      await handleRunComplete({ run: { agentName: "chat", status: "success" }, conversationId: "c2" });
    } finally {
      cap.restore();
    }

    expect(cap.warnings.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// distill_now tool dispatcher — argument validation only.
// (End-to-end success/decline coverage flows through `distill` above —
// the tool wraps `distillFromMessages` which is the same shape.)
// ─────────────────────────────────────────────────────────────────────

describe("distill_now tool — argument validation", () => {
  test("missing conversationId → tool error", async () => {
    const handler = tools.distill_now!;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("conversationId");
  });

  test("non-string conversationId → tool error", async () => {
    const handler = tools.distill_now!;
    const result = await handler({ conversationId: 123 });
    expect(result.isError).toBe(true);
  });

  test("disabled setting → returns settings_disabled decline envelope", async () => {
    const handler = tools.distill_now!;
    // Provide ctx.invocationMetadata.settings with enabled=false; the
    // tool reads via `getSetting(ctx, "enabled")`.
    const result = await handler(
      { conversationId: "conv-1" },
      {
        invocationMetadata: {
          settings: { enabled: false },
        },
      },
    );
    expect(result.isError).toBeFalsy();
    const env = parseEnvelope(result.content[0]!.text);
    expect(env.__ezDistillerOutcome).toBe(true);
    expect(env.outcome.kind).toBe("decline");
    if (env.outcome.kind === "decline") {
      expect(env.outcome.reason).toBe("settings_disabled");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Loop migration — distillRunComplete shared core (settings-injected) +
// defineDistillLoop registration. The act-result mapping (skip/terminal)
// rides on the SDK loop facade (covered by the SDK loop suite); here we
// pin the extension-owned shared core that BOTH the listener path and the
// loop act call, so the gating + outcome contract has 1:1 coverage.
// ─────────────────────────────────────────────────────────────────────

describe("distillRunComplete — shared settings-injected core", () => {
  test("settings.enabled=false → undefined (gated, no distill)", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    const out = await distillRunComplete(
      { run: { agentName: "chat", status: "success" }, conversationId: "c1" },
      { enabled: false },
    );
    expect(out).toBeUndefined();
    expect(fake.calls.find((c) => c.api === "llmComplete")).toBeUndefined();
  });

  test("wrong agent/status → undefined", async () => {
    const fake = makeFakeRuntime();
    _setRuntimeApiForTests(fake.api);
    expect(
      await distillRunComplete(
        { run: { agentName: "team", status: "success" }, conversationId: "c1" },
        { enabled: true },
      ),
    ).toBeUndefined();
  });

  test("happy path → success outcome (settings come from the caller)", async () => {
    const fake = makeFakeRuntime();
    fake.setSettings({}); // not consulted — settings are injected
    _setRuntimeApiForTests(fake.api);
    const out = await distillRunComplete(
      { run: { agentName: "chat", status: "success" }, conversationId: "c1" },
      { enabled: true, provider: "openai", model: "" },
    );
    expect(out?.kind).toBe("success");
    // provider override threaded through to the LLM call
    const llmCall = fake.calls.find((c) => c.api === "llmComplete");
    expect(llmCall?.args).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("conversation unwired (-32604) → undefined, fail-soft", async () => {
    const fake = makeFakeRuntime({
      async getMessagesEnvelope() {
        throw new (await import("@ezcorp/sdk/runtime")).JsonRpcError(-32604, "not wired");
      },
    });
    _setRuntimeApiForTests(fake.api);
    expect(
      await distillRunComplete(
        { run: { agentName: "chat", status: "success" }, conversationId: "c1" },
        { enabled: true },
      ),
    ).toBeUndefined();
  });
});

describe("defineDistillLoop — registration", () => {
  test("registers the run:complete capture loop without throwing", () => {
    // Tests run with `import.meta.main` false, so the boot wiring never
    // ran — registering once here is safe (no duplicate-id collision).
    expect(() => defineDistillLoop()).not.toThrow();
  });
});
