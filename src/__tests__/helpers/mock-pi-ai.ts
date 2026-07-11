/**
 * Shared mock helpers for pi-ai/pi-agent-core in tests.
 *
 * Provides reusable factories for AssistantMessage stubs, mock streams,
 * and configurable pi-agent-core Agent mocks. Centralizes the mock patterns
 * so 15+ test files don't each duplicate them.
 */
import { mock } from "bun:test";

// ── AssistantMessage stub ────────────────────────────────────────────

export function stubAssistantMessage(text = "Hello world", overrides: Record<string, any> = {}): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Mock pi-ai stream ────────────────────────────────────────────────

export function createMockPiStream(events: any[], finalMessage?: any) {
  const msg = finalMessage ?? stubAssistantMessage();
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    result: () => Promise.resolve(msg),
  };
}

/** Standard text_delta + done event sequence */
export function defaultStreamEvents(text = "Hello world") {
  const msg = stubAssistantMessage(text);
  return [
    { type: "text_delta", contentIndex: 0, delta: text, partial: msg },
    { type: "done", reason: "stop", message: msg },
  ];
}

/** Split text into individual character deltas for streaming tests */
export function textDeltaEvents(chunks: string[]) {
  let accumulated = "";
  const events: any[] = [];
  for (const chunk of chunks) {
    accumulated += chunk;
    events.push({
      type: "text_delta",
      contentIndex: 0,
      delta: chunk,
      partial: stubAssistantMessage(accumulated),
    });
  }
  events.push({
    type: "done",
    reason: "stop",
    message: stubAssistantMessage(accumulated),
  });
  return events;
}

/** Error event sequence */
export function errorStreamEvents(errorText = "Stream error") {
  return [
    {
      type: "error",
      reason: "error",
      error: stubAssistantMessage(errorText, {
        content: [{ type: "text", text: errorText }],
      }),
    },
  ];
}

// ── Mock pi-agent-core Agent ─────────────────────────────────────────

export type AgentEventCallback = (event: any) => void;

/**
 * Configurable mock Agent class.
 * Set `mockAgentPromptFn` to control what happens when `prompt()` is called.
 * Subscribers registered via `subscribe()` will be called with events.
 */
export let mockAgentPromptFn: ((message: string) => AsyncGenerator<any> | Promise<void>) | null = null;
let _subscribers: AgentEventCallback[] = [];

export function resetMockAgent() {
  mockAgentPromptFn = null;
  _subscribers = [];
}

/**
 * Creates the standard module mocks for pi-ai + pi-agent-core + router + credentials.
 * Call this BEFORE importing any module that depends on these.
 *
 * Options:
 * - streamEvents: events the pi-ai stream() returns (default: "Hello world" stream)
 * - completeText: text returned by pi-ai complete() (default: "Hello world")
 * - promptBehavior: "text" (default) emits text events via subscriber, "custom" uses mockAgentPromptFn
 */
export function setupPiAiMocks(opts: {
  streamEvents?: any[];
  completeText?: string;
  promptBehavior?: "text" | "custom";
  textChunks?: string[];
} = {}) {
  const streamEvents = opts.streamEvents ?? textDeltaEvents(opts.textChunks ?? ["Hello", " world"]);
  const completeText = opts.completeText ?? "Hello world";
  const behavior = opts.promptBehavior ?? "text";

  // Paths are relative to THIS file (src/__tests__/helpers/), so ../../ reaches src/
  mock.module("../../providers/router", () => ({
    // Mirrors the REAL resolveModel contract: an explicit provider+model pin
    // passes through verbatim (Level-1 passthrough — the persisted message
    // row must name the pin, see chat-e2e-comprehensive), everything else
    // resolves to the default anthropic/test-model stub.
    resolveModel: async (provider?: string, modelId?: string) => {
      const p = provider && modelId ? provider : "anthropic";
      const m = provider && modelId ? modelId : "test-model";
      return {
        provider: p,
        model: m,
        piModel: {
          id: m,
          provider: p,
          api: "anthropic-messages",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 4096,
        },
      };
    },
    getDefaultTier: async () => "balanced",
    createRoutedStream: async () => createMockPiStream(streamEvents),
    createRoutedComplete: async () => stubAssistantMessage(completeText),
    ProviderUnavailableError: class extends Error {
      failedProvider: string;
      failedModel: string;
      suggestion: any;
      constructor(msg: string, fp: string, fm: string, sug: any) {
        super(msg);
        this.failedProvider = fp;
        this.failedModel = fm;
        this.suggestion = sug;
      }
    },
  }));

  mock.module("../../providers/credentials", () => ({
    getCredential: async () => ({ type: "apikey", token: "test-key" }),
    getApiKey: async () => "test-key",
  }));

  mock.module("@earendil-works/pi-ai/compat", () => ({
    stream: () => createMockPiStream(streamEvents),
    complete: async () => stubAssistantMessage(completeText),
    getModel: () => ({
      id: "test-model",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    }),
    getModels: () => [],
    getProviders: () => ["anthropic", "openai", "google"],
    getEnvApiKey: () => undefined,
  }));

  mock.module("@earendil-works/pi-agent-core", () => ({
    Agent: class MockAgent {
      state = { error: null };
      private _subscribers: AgentEventCallback[] = [];
      constructor(opts: any) {
        // Store subscribers list for emitting events
        _subscribers = this._subscribers;
      }
      subscribe(cb: AgentEventCallback) {
        this._subscribers.push(cb);
        _subscribers = this._subscribers;
        return () => {
          const idx = this._subscribers.indexOf(cb);
          if (idx >= 0) this._subscribers.splice(idx, 1);
        };
      }
      abort() {}
      async prompt(message: string) {
        if (behavior === "custom" && mockAgentPromptFn) {
          await mockAgentPromptFn(message);
          return;
        }
        // Default: emit text deltas then turn_end via subscriber
        const chunks = opts.textChunks ?? ["Hello", " world"];
        let accumulated = "";
        for (const chunk of chunks) {
          accumulated += chunk;
          for (const sub of this._subscribers) {
            sub({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: chunk,
                partial: stubAssistantMessage(accumulated),
              },
            });
          }
        }
        // Emit turn_end
        const finalUsage = {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        for (const sub of this._subscribers) {
          sub({
            type: "turn_end",
            message: stubAssistantMessage(accumulated, { usage: finalUsage }),
          });
        }
      }
    },
  }));
}
