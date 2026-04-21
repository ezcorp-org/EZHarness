import { AsyncLocalStorage } from "node:async_hooks";
import {
  createConversationInput,
  sendMessageInput,
  generateAgentInput,
  createAgentInput,
  mentionSearchInput,
  assignTaskInput,
  startAssignmentInput,
  spawnChatsInput,
  type CreateConversationInput,
  type SendMessageInput,
  type GenerateAgentInput,
  type CreateAgentInput,
  type MentionSearchInput,
  type AssignTaskInput,
  type StartAssignmentInput,
  type SpawnChatsInput,
  type Project,
  type Conversation,
  type Message,
  type AgentConfig,
  type SendMessageResult,
  type SpawnChatsResult,
  type MentionHit,
  type GenerateAgentResult,
  type RuntimeEvent,
} from "./types";
import { entityUrl, type EntityRef } from "./urls.js";

/** Per-call context threaded via JSON-RPC `_meta` by the EZCorp executor
 *  (see src/extensions/tool-executor.ts). Populated on each tool call by
 *  the MCP server wrapper, read by the client when it builds outbound
 *  requests. All three fields are server-supplied and NOT under LLM
 *  control — the wrapper extracts them from `extra._meta` on the MCP
 *  request, which is outside the LLM-visible arguments.
 *
 *  - `onBehalfOf` — the user the calling conversation is owned by.
 *    Added as `X-Ezcorp-On-Behalf-Of` header; trusted server-side only
 *    for internal-auth principals on loopback.
 *  - `defaultModel` / `defaultProvider` — inherited from the calling
 *    conversation. Merged into `createConversation` / `sendMessage` /
 *    `startAssignment` / `spawnChats` bodies ONLY when the LLM's own
 *    args don't specify a value. Explicit LLM overrides always win. */
export interface AiKitCallContext {
  onBehalfOf?: string;
  defaultModel?: string;
  defaultProvider?: string;
  /** Public origin of the EZCorp web UI (e.g. `https://ezcorp.example.com`).
   *  Set by the MCP server wrapper from `_meta.ezPublicUrl`; consumed by
   *  `client.entityUrl()` when composing clickable links in tool
   *  responses. Falls back to `client.publicUrl` when unset. */
  publicUrl?: string;
}

export const callContext = new AsyncLocalStorage<AiKitCallContext>();

/** Back-compat alias — `onBehalfOfContext` was the original single-purpose
 *  store. Callers that set only the OBO field still work; they get an
 *  empty defaultModel/Provider, which is the pre-change behavior. */
export const onBehalfOfContext = {
  run<T>(userId: string, fn: () => T): T {
    return callContext.run({ onBehalfOf: userId }, fn);
  },
  getStore(): string | undefined {
    return callContext.getStore()?.onBehalfOf;
  },
};

export interface ClientOptions {
  baseUrl?: string;
  /** Public origin used to build clickable URLs returned in tool
   *  responses. Resolved from: explicit option → `EZCORP_PUBLIC_URL`
   *  env → `baseUrl`. Separate from `baseUrl` so a subprocess can call
   *  the API on loopback while still handing the user links on the
   *  real public domain. */
  publicUrl?: string;
  apiKey?: string;
  sessionCookie?: string;
  fetch?: typeof fetch;
}

export class EzcorpApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`EZCorp API ${status} at ${url}: ${body.slice(0, 200)}`);
    this.name = "EzcorpApiError";
  }
}

export class EzcorpClient {
  readonly baseUrl: string;
  readonly publicUrl: string;
  private readonly apiKey?: string;
  private readonly sessionCookie?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.EZCORP_BASE_URL ?? "http://localhost:5173").replace(
      /\/+$/,
      "",
    );
    this.publicUrl = (opts.publicUrl ?? process.env.EZCORP_PUBLIC_URL ?? this.baseUrl).replace(
      /\/+$/,
      "",
    );
    this.apiKey = opts.apiKey ?? process.env.EZCORP_API_KEY;
    this.sessionCookie = opts.sessionCookie ?? process.env.EZCORP_SESSION_COOKIE;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Build a canonical clickable URL for an EZCorp entity. Prefers the
   *  per-call `publicUrl` threaded through `_meta.ezPublicUrl` (set by
   *  the MCP server wrapper) and falls back to `this.publicUrl`. Tool
   *  handlers use this when wrapping responses so the user can jump
   *  straight from chat to the entity in the UI. */
  entityUrl(ref: EntityRef): string {
    const base = callContext.getStore()?.publicUrl ?? this.publicUrl;
    return entityUrl(base, ref);
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.sessionCookie) h["Cookie"] = `ezcorp_session=${this.sessionCookie}`;
    const onBehalfOf = callContext.getStore()?.onBehalfOf;
    if (onBehalfOf) h["X-Ezcorp-On-Behalf-Of"] = onBehalfOf;
    return h;
  }

  /** Merge per-call ALS defaults (`defaultModel`, `defaultProvider`) into
   *  a body shape. Explicit caller-supplied values ALWAYS win — defaults
   *  only fill gaps. Used by every method whose payload can specify a
   *  model (createConversation, sendMessage, startAssignment). Kept as a
   *  private helper so the merge is in one place and testable via the
   *  AsyncLocalStorage scope in integration tests. */
  private withModelDefaults<T extends { model?: string; provider?: string }>(
    body: T,
  ): T {
    const ctx = callContext.getStore();
    if (!ctx) return body;
    return {
      ...body,
      model: body.model ?? ctx.defaultModel,
      provider: body.provider ?? ctx.defaultProvider,
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.authHeaders(),
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.body && !(init.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await this.fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      throw new EzcorpApiError(res.status, url.toString(), await res.text());
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ────── health ──────

  health(): Promise<{ ok: boolean }> {
    return this.request("/api/health");
  }

  me(): Promise<{ id: string; name: string; email: string; role: string }> {
    return this.request("/api/auth/me");
  }

  // ────── projects ──────

  listProjects(): Promise<Project[]> {
    return this.request("/api/projects");
  }

  createProject(body: { name: string; path: string; icon?: string }): Promise<Project> {
    return this.request("/api/projects", { method: "POST", body: JSON.stringify(body) });
  }

  getProject(id: string): Promise<Project> {
    return this.request(`/api/projects/${encodeURIComponent(id)}`);
  }

  // ────── conversations ──────

  listConversations(opts: {
    projectId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<Conversation[]> {
    return this.request("/api/conversations", {
      query: {
        projectId: opts.projectId,
        limit: opts.limit?.toString(),
        offset: opts.offset?.toString(),
        search: opts.search,
      },
    });
  }

  createConversation(body: CreateConversationInput): Promise<Conversation> {
    const parsed = createConversationInput.parse(this.withModelDefaults(body));
    return this.request("/api/conversations", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  }

  getConversation(id: string): Promise<Conversation> {
    return this.request(`/api/conversations/${id}`);
  }

  getMessages(
    id: string,
    opts: { leafMessageId?: string; all?: boolean; withToolCalls?: boolean } = {},
  ): Promise<Message[]> {
    return this.request(`/api/conversations/${id}/messages`, {
      query: {
        leafMessageId: opts.leafMessageId,
        all: opts.all ? "true" : undefined,
        withToolCalls: opts.withToolCalls ? "true" : undefined,
      },
    });
  }

  sendMessage(conversationId: string, body: SendMessageInput): Promise<SendMessageResult> {
    const parsed = sendMessageInput.parse(this.withModelDefaults(body));
    return this.request(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  }

  cancelRun(conversationId: string, force = false): Promise<{ ok: boolean }> {
    return this.request(`/api/conversations/${conversationId}/active-run`, {
      method: "POST",
      body: JSON.stringify({ action: force ? "force-cancel" : "cancel" }),
    });
  }

  getSubConversations(id: string): Promise<Conversation[]> {
    return this.request(`/api/conversations/${id}/sub-conversations`);
  }

  // ────── tasks ──────

  getTasks(conversationId: string): Promise<unknown> {
    return this.request(`/api/conversations/${conversationId}/tasks`);
  }

  assignTask(body: AssignTaskInput): Promise<{ assignment: { id: string; status: string } }> {
    const p = assignTaskInput.parse(body);
    return this.request(`/api/conversations/${p.conversationId}/tasks/${p.taskId}/assign`, {
      method: "POST",
      body: JSON.stringify({ agentConfigId: p.agentConfigId, subtaskId: p.subtaskId }),
    });
  }

  startAssignment(
    body: StartAssignmentInput,
  ): Promise<{ runId: string; subConversationId: string }> {
    const p = startAssignmentInput.parse(this.withModelDefaults(body));
    return this.request(
      `/api/conversations/${p.conversationId}/tasks/${p.taskId}/assignments/${p.assignmentId}/start`,
      { method: "POST", body: JSON.stringify({ model: p.model, provider: p.provider }) },
    );
  }

  // ────── agent configs ──────

  listAgents(): Promise<AgentConfig[]> {
    return this.request("/api/agent-configs");
  }

  createAgent(body: CreateAgentInput): Promise<AgentConfig> {
    const parsed = createAgentInput.parse(body);
    return this.request("/api/agent-configs", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  }

  generateAgent(body: GenerateAgentInput): Promise<GenerateAgentResult> {
    const parsed = generateAgentInput.parse(body);
    return this.request("/api/agent-configs/generate", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
  }

  // ────── mentions ──────

  searchMentions(input: MentionSearchInput): Promise<MentionHit[]> {
    const p = mentionSearchInput.parse(input);
    return this.request("/api/mentions/search", {
      query: { q: p.q, type: p.type, projectId: p.projectId },
    });
  }

  // ────── models / extensions ──────

  listModels(): Promise<unknown[]> {
    return this.request("/api/models");
  }

  listExtensions(): Promise<unknown[]> {
    return this.request("/api/extensions");
  }

  // ────── runtime events (SSE) ──────

  async *streamEvents(opts: { signal?: AbortSignal } = {}): AsyncGenerator<RuntimeEvent> {
    const url = new URL(this.baseUrl + "/api/runtime-events");
    const res = await this.fetchImpl(url, {
      headers: { Accept: "text/event-stream", ...this.authHeaders() },
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new EzcorpApiError(res.status, url.toString(), await res.text().catch(() => ""));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = chunk
            .split("\n")
            .find((l) => l.startsWith("data:"))
            ?.slice(5)
            .trim();
          if (!dataLine || dataLine === "ping") continue;
          try {
            yield JSON.parse(dataLine) as RuntimeEvent;
          } catch {
            // ignore malformed frames; heartbeat-style comments use `: ping` syntax
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Spawn N root-level independent chats. This is the `![agent:…]`-style
   *  fan-out but at the *parent* conversation level rather than sub-conversation.
   *  Returns one entry per input; individual failures throw — caller wraps in
   *  Promise.allSettled if partial success is acceptable. */
  async spawnChats(body: SpawnChatsInput): Promise<SpawnChatsResult> {
    const parsed = spawnChatsInput.parse(body);
    const results = await Promise.all(
      parsed.chats.map(async (spec) => {
        const conv = await this.createConversation({
          projectId: spec.projectId,
          agentConfigId: spec.agentConfigId,
          model: spec.model,
          provider: spec.provider,
          title: spec.title,
        });
        const { runId } = await this.sendMessage(conv.id, { content: spec.initialMessage });
        return { conversationId: conv.id, runId };
      }),
    );
    return { chats: results };
  }
}
