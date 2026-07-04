/**
 * @ezcorp/harness-client — remote-control client for an EZCorp instance.
 *
 * Lets an external runner (Playwright, CI script, or another agent)
 * authenticate with a bearer API key and: configure settings, create + drive
 * conversations, observe the runtime SSE stream with runId correlation,
 * approve tool-call permission gates, and (against a test-mode instance)
 * script the deterministic mock LLM. Transport-agnostic: configurable
 * baseUrl + apiKey + fetch, no SvelteKit/cookie coupling.
 *
 * See README.md for a worked example.
 */
export * from "./events";
export { SseDataBuffer } from "./sse";

import { SseDataBuffer } from "./sse";
import type { RuntimeEvent } from "./events";

export interface HarnessClientOptions {
  /** Base origin of the EZCorp instance, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** `ezk_*` API key (mint via `ezcorp key mint`). Sent as a bearer token. */
  apiKey?: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

export interface MockToolCall {
  id?: string;
  name: string;
  arguments?: Record<string, unknown> | string;
}
export interface MockTurn {
  text?: string;
  toolCalls?: MockToolCall[];
  finishReason?: "stop" | "tool_calls" | "length";
}

export interface SendMessageOptions {
  provider?: string;
  model?: string;
  parentMessageId?: string;
  permissionMode?: "ask" | "auto-edit" | "yolo";
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface SendMessageResult {
  userMessage: { id: string; [k: string]: unknown };
  runId: string | null;
  [k: string]: unknown;
}

export interface RunResult {
  outcome: "complete" | "error" | "cancel";
  run: Record<string, unknown> & { id: string; status: string; result?: { output?: unknown; error?: unknown } };
  error?: string;
}

export class HarnessApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`${method} ${path} → ${status}: ${typeof body === "object" && body && "error" in body ? (body as { error: string }).error : status}`);
    this.name = "HarnessApiError";
  }
}

export class HarnessClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HarnessClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { "Content-Type": "application/json" } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Never follow a 3xx: a cross-origin redirect would replay the
      // `Authorization: Bearer ezk_*` header to an attacker-controlled host.
      redirect: "error",
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) throw new HarnessApiError(res.status, method, path, parsed ?? text);
    return parsed as T;
  }

  // ── Configure ──────────────────────────────────────────────────────
  getSetting<T = unknown>(key: string): Promise<T> {
    return this.request("GET", `/api/settings/${encodeURIComponent(key)}`);
  }
  setSetting(key: string, value: unknown): Promise<unknown> {
    return this.request("PUT", `/api/settings/${encodeURIComponent(key)}`, { value });
  }

  // ── Conversations + drive ──────────────────────────────────────────
  /** `projectId` is REQUIRED by the server (`createConversationSchema`);
   *  default it to the `"global"` project so the zero-config call works —
   *  an explicit `input.projectId` always wins. */
  createConversation(input: Record<string, unknown> = {}): Promise<{ id: string; [k: string]: unknown }> {
    return this.request("POST", `/api/conversations`, { projectId: "global", ...input });
  }
  sendMessage(conversationId: string, content: string, opts: SendMessageOptions = {}): Promise<SendMessageResult> {
    return this.request("POST", `/api/conversations/${encodeURIComponent(conversationId)}/messages`, { content, ...opts });
  }

  // ── Run-to-completion ──────────────────────────────────────────────
  getRun(runId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/runs/${encodeURIComponent(runId)}`);
  }
  /** Block until the run reaches a terminal state (server-side wait). */
  awaitRun(runId: string, timeoutMs = 120_000): Promise<RunResult> {
    return this.request("GET", `/api/runs/${encodeURIComponent(runId)}?wait=1&timeoutMs=${timeoutMs}`);
  }
  /** Send a message and block until its run finishes. */
  async runToCompletion(conversationId: string, content: string, opts: SendMessageOptions & { timeoutMs?: number } = {}): Promise<RunResult> {
    const { timeoutMs, ...send } = opts;
    const { runId } = await this.sendMessage(conversationId, content, send);
    if (!runId) throw new Error("Message produced no run (action-only or disabled command)");
    return this.awaitRun(runId, timeoutMs);
  }

  // ── Tool-call permission gates ─────────────────────────────────────
  resolveToolPermission(
    toolCallId: string,
    approved: boolean,
    opts: { scope?: "session" | "conversation" | "project" | "forever"; ttlOverrideMs?: number } = {},
  ): Promise<unknown> {
    return this.request("POST", `/api/tool-calls/${encodeURIComponent(toolCallId)}/permission`, { approved, ...opts });
  }

  // ── Deterministic mock LLM (test-mode instances only) ──────────────
  scriptLlm(scriptKey: string, turns: MockTurn[]): Promise<unknown> {
    return this.request("POST", `/api/__test/mock-llm/script`, { scriptKey, turns });
  }
  clearLlmScripts(): Promise<unknown> {
    return this.request("DELETE", `/api/__test/mock-llm/script`);
  }
  /**
   * Convenience: script a deterministic turn list, then drive a message
   * selecting the mock provider, and await the run. `scriptKey` defaults to
   * the conversation id. Uses `permissionMode: "yolo"` so tool turns
   * auto-approve unless overridden.
   */
  async runScripted(
    conversationId: string,
    content: string,
    turns: MockTurn[],
    opts: { scriptKey?: string; permissionMode?: SendMessageOptions["permissionMode"]; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const scriptKey = opts.scriptKey ?? conversationId;
    await this.scriptLlm(scriptKey, turns);
    return this.runToCompletion(conversationId, content, {
      provider: "ezcorp-mock",
      model: `mock:${scriptKey}`,
      permissionMode: opts.permissionMode ?? "yolo",
      timeoutMs: opts.timeoutMs,
    });
  }

  // ── Observe (SSE) ──────────────────────────────────────────────────
  /**
   * Async iterator over the runtime SSE stream. Pass an AbortSignal to stop.
   * Optional `conversationId` scopes the server-side subscription hint.
   */
  async *streamEvents(opts: { conversationId?: string; signal?: AbortSignal } = {}): AsyncGenerator<RuntimeEvent> {
    const qs = opts.conversationId ? `?conversationId=${encodeURIComponent(opts.conversationId)}` : "";
    const res = await this.fetchImpl(`${this.baseUrl}/api/runtime-events${qs}`, {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal: opts.signal,
      // Mirror request(): never follow a 3xx — a cross-origin redirect would
      // replay the `Authorization: Bearer ezk_*` header to an attacker host.
      redirect: "error",
    });
    if (!res.ok || !res.body) throw new HarnessApiError(res.status, "GET", "/api/runtime-events", await res.text().catch(() => ""));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const buf = new SseDataBuffer();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of buf.push(decoder.decode(value, { stream: true }))) {
          const evt = safeJson(payload);
          if (evt && typeof evt === "object") yield evt as RuntimeEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
