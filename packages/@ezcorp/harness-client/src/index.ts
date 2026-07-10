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
export * from "./routes";
export { SseDataBuffer } from "./sse";

import { SseDataBuffer } from "./sse";
import type { RuntimeEvent } from "./events";
import { HARNESS_ROUTES, buildPath, type HarnessRouteName } from "./routes";

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
/** Synthetic token usage (incl. cache hits/misses) reported on a mock turn.
 *  Mirrors the server's `MockUsage`; maps 1:1 onto the parsed
 *  `AssistantMessage.usage` that flows through the `run:usage` event. */
export interface MockUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}
/** A deterministic provider failure for a mock turn. Mirrors the server's
 *  `MockFault`: `status` (400–599) fails at that HTTP status (429/5xx);
 *  `kind:"connection"` aborts the body pre-first-token (transport failure). */
export interface MockFault {
  status?: number;
  kind?: "connection";
  message?: string;
}
export interface MockTurn {
  text?: string;
  toolCalls?: MockToolCall[];
  finishReason?: "stop" | "tool_calls" | "length";
  /** Synthetic usage (incl. cache hits/misses) reported on this turn. */
  usage?: MockUsage;
  /** Fail this turn deterministically instead of replying (retry/failover). */
  fault?: MockFault;
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

/** An installed-extension row as the server returns it. `id` is the extensions-
 *  table UUID (the `:id` path param for lifecycle routes); `name` is the stable
 *  manifest slug (used for wiring + secrets). Extra columns pass through. */
export interface ExtensionRecord {
  id: string;
  name: string;
  enabled?: boolean;
  [k: string]: unknown;
}

/** Source for `installExtension`. Mirrors the server's `installExtensionSchema`:
 *  `local` needs `path`, `github` needs `repo`, `git` needs `url` (+ optional
 *  `ref`). The server clones/enables nothing beyond the manifest declaration —
 *  install lands disabled; grant + enable happen via `activateExtension`. */
export type InstallExtensionInput =
  | { source: "local"; path: string }
  | { source: "github"; repo: string }
  | { source: "git"; url: string; ref?: string };

/** Result of a hub action dispatch: `{ ok }`, optionally with a freshly
 *  rendered page tree when the action returned one. */
export interface HubActionResult {
  ok: boolean;
  page?: unknown;
  renderedAt?: number;
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

  /** Drive a named route from the shared `HARNESS_ROUTES` table: resolves the
   *  HTTP method + path template once, substitutes `:param` segments, and
   *  delegates to `request()`. Every single-request method routes through here
   *  so a path string is never written inline. */
  private route<T>(name: HarnessRouteName, params?: Record<string, string>, body?: unknown): Promise<T> {
    const r = HARNESS_ROUTES[name];
    return this.request<T>(r.httpMethod, buildPath(r.pathTemplate, params), body);
  }

  // ── Configure ──────────────────────────────────────────────────────
  getSetting<T = unknown>(key: string): Promise<T> {
    return this.route("getSetting", { key });
  }
  setSetting(key: string, value: unknown): Promise<unknown> {
    return this.route("setSetting", { key }, { value });
  }

  // ── Conversations + drive ──────────────────────────────────────────
  /** `projectId` is REQUIRED by the server (`createConversationSchema`);
   *  default it to the `"global"` project so the zero-config call works —
   *  an explicit `input.projectId` always wins. */
  createConversation(input: Record<string, unknown> = {}): Promise<{ id: string; [k: string]: unknown }> {
    return this.route("createConversation", undefined, { projectId: "global", ...input });
  }
  sendMessage(conversationId: string, content: string, opts: SendMessageOptions = {}): Promise<SendMessageResult> {
    return this.route("sendMessage", { id: conversationId }, { content, ...opts });
  }

  // ── Extensions ─────────────────────────────────────────────────────
  /** List installed extensions. `GET /api/extensions` returns a bare array;
   *  a `{ extensions: [...] }` wrapper is tolerated too. Any other shape throws
   *  (a silent `[]` would mask a contract drift as "no extensions installed"). */
  async listExtensions(): Promise<ExtensionRecord[]> {
    const res = await this.route<unknown>("listExtensions");
    if (Array.isArray(res)) {
      return res as ExtensionRecord[];
    }
    if (res && typeof res === "object" && Array.isArray((res as { extensions?: unknown }).extensions)) {
      return (res as { extensions: ExtensionRecord[] }).extensions;
    }
    throw new Error(
      `listExtensions: unexpected /api/extensions response shape — expected an array or { extensions: [...] }, got ${res === null ? "null" : typeof res}`,
    );
  }

  /** Install an extension from a local path, a GitHub release, or a git clone
   *  URL (`POST /api/extensions`). Requires an admin-ROLE key. The install lands
   *  DISABLED with no permissions granted — call `activateExtension` next to
   *  enable it and grant its manifest-declared permissions. Returns the new
   *  extension row (its `id` is the `:id` param for the lifecycle routes). */
  installExtension(input: InstallExtensionInput): Promise<ExtensionRecord> {
    return this.route("installExtension", undefined, input);
  }

  /** Enable an installed extension and (optionally) grant permissions
   *  (`POST /api/extensions/:id/activate`). Requires an admin-ROLE key. Omit
   *  `grantedPermissions` to just flip enabled=true; when supplied it is clamped
   *  to the manifest (nothing beyond what the author declared is granted).
   *  Returns the updated extension row. */
  activateExtension(
    extensionId: string,
    grantedPermissions?: Record<string, unknown>,
  ): Promise<ExtensionRecord> {
    return this.route(
      "activateExtension",
      { id: extensionId },
      grantedPermissions !== undefined ? { grantedPermissions } : {},
    );
  }

  /** Enable/disable an installed extension (`PATCH /api/extensions/:id`).
   *  Requires an admin-ROLE key + the `extensions` scope. NOTE: the server only
   *  permits DISABLING here (`enabled: false`); passing `true` returns 400 —
   *  enabling must go through `activateExtension` (which does the manifest-
   *  clamped permission review). Returns the updated extension row. */
  setExtensionEnabled(extensionId: string, enabled: boolean): Promise<ExtensionRecord> {
    return this.route("setExtensionEnabled", { id: extensionId }, { enabled });
  }

  /** Uninstall an extension (`DELETE /api/extensions/:id`). Requires an
   *  admin-ROLE key + the `extensions` scope. Destructive + instance-wide:
   *  kills the subprocess, drops the DB row, invalidates cached Hub pages.
   *  Resolves (204, no body) on success. */
  uninstallExtension(extensionId: string): Promise<void> {
    return this.route("uninstallExtension", { id: extensionId });
  }

  /** Replace an extension's granted permissions (`PUT /api/extensions/:id/permissions`).
   *  Requires an admin-ROLE key. The submitted permissions are clamped to the
   *  manifest — anything beyond the author's declaration is dropped silently.
   *  Returns the updated extension row. */
  updateExtensionPermissions(
    extensionId: string,
    permissions: Record<string, unknown>,
  ): Promise<ExtensionRecord> {
    return this.route("updateExtensionPermissions", { id: extensionId }, { permissions });
  }

  /** Set (or rotate) a scope-isolated extension secret
   *  (`POST /api/extensions/:id/secrets`). Needs the `extensions` scope plus the
   *  per-extension `secrets` RBAC scope at `projectId` (`null`/omitted = the
   *  instance-wide scope; admins hold every scope). The plaintext `value` is
   *  never echoed back. */
  setExtensionSecret(
    extensionId: string,
    name: string,
    value: string,
    opts: { projectId?: string | null } = {},
  ): Promise<{ ok: true }> {
    return this.route("setExtensionSecret", { id: extensionId }, {
      name,
      value,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    });
  }

  /** Delete a scope-isolated extension secret
   *  (`DELETE /api/extensions/:id/secrets`). Same authz as `setExtensionSecret`.
   *  `deleted` is false when no matching secret existed. */
  deleteExtensionSecret(
    extensionId: string,
    name: string,
    opts: { projectId?: string | null } = {},
  ): Promise<{ deleted: boolean }> {
    return this.route("deleteExtensionSecret", { id: extensionId }, {
      name,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    });
  }

  /** Wire installed extensions (by manifest name) to a conversation. All-or-
   *  nothing: an unknown name 404s and wires nothing. Idempotent — re-wiring an
   *  already-wired extension is a no-op success. */
  wireExtensions(conversationId: string, names: string[]): Promise<{ wired: string[]; extensionIds: string[] }> {
    return this.route("wireExtensions", { id: conversationId }, { names });
  }

  /** List the extensions wired to a conversation. */
  async listWiredExtensions(conversationId: string): Promise<Array<{ id: string; name: string }>> {
    const res = await this.route<{ extensions: Array<{ id: string; name: string }> }>(
      "listWiredExtensions",
      { id: conversationId },
    );
    return res.extensions;
  }

  /** Invoke an extension tool directly via `POST /api/tool-invoke`. A missing
   *  `invocationId` is auto-generated. The extension must already be wired to
   *  the conversation for storage-scoped tools to succeed. A tool-level failure
   *  resolves (not throws) with `{ success: false, error }`; an unknown tool or
   *  a scope/ownership rejection throws `HarnessApiError`. */
  invokeExtensionTool(
    conversationId: string,
    extensionName: string,
    toolName: string,
    input: Record<string, unknown> = {},
    opts: { invocationId?: string; messageId?: string } = {},
  ): Promise<{ success: boolean; output?: unknown; error?: string; [k: string]: unknown }> {
    return this.route("invokeExtensionTool", undefined, {
      conversationId,
      extensionName,
      toolName,
      input,
      invocationId: opts.invocationId ?? crypto.randomUUID(),
      ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
    });
  }

  /** Dispatch a named action on a CORE Hub page
   *  (`POST /api/hub/pages/:id/actions/:action`). Needs the `chat` scope.
   *  `payload` values must be scalars (string | number | boolean). Returns
   *  `{ ok }`, optionally with a freshly rendered `page` tree. */
  triggerHubAction(
    pageId: string,
    action: string,
    payload?: Record<string, string | number | boolean>,
  ): Promise<HubActionResult> {
    return this.route(
      "triggerHubAction",
      { id: pageId, action },
      payload !== undefined ? { payload } : {},
    );
  }

  // ── Run-to-completion ──────────────────────────────────────────────
  getRun(runId: string): Promise<Record<string, unknown>> {
    return this.route("getRun", { id: runId });
  }
  /** Block until the run reaches a terminal state (server-side wait). */
  awaitRun(runId: string, timeoutMs = 120_000): Promise<RunResult> {
    const { httpMethod, pathTemplate } = HARNESS_ROUTES.awaitRun;
    return this.request(httpMethod, `${buildPath(pathTemplate, { id: runId })}?wait=1&timeoutMs=${timeoutMs}`);
  }
  /** Cancel an in-flight run (`DELETE /api/runs/:id`). Needs the `chat` scope;
   *  ownership-gated (a non-owner sees 404). `ok` is false-ish via a 404 when
   *  the run isn't running. */
  cancelRun(runId: string): Promise<{ ok: boolean }> {
    return this.route("cancelRun", { id: runId });
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
    return this.route("resolveToolPermission", { id: toolCallId }, { approved, ...opts });
  }

  // ── Deterministic mock LLM (test-mode instances only) ──────────────
  scriptLlm(scriptKey: string, turns: MockTurn[]): Promise<unknown> {
    return this.route("scriptLlm", undefined, { scriptKey, turns });
  }
  clearLlmScripts(): Promise<unknown> {
    return this.route("clearLlmScripts");
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
    // Path comes from the shared table; the SSE-specific fetch (streaming body,
    // text/event-stream Accept) stays here.
    const { httpMethod, pathTemplate } = HARNESS_ROUTES.streamEvents;
    const path = buildPath(pathTemplate);
    const qs = opts.conversationId ? `?conversationId=${encodeURIComponent(opts.conversationId)}` : "";
    const res = await this.fetchImpl(`${this.baseUrl}${path}${qs}`, {
      method: httpMethod,
      headers: this.headers({ Accept: "text/event-stream" }),
      signal: opts.signal,
      // Mirror request(): never follow a 3xx — a cross-origin redirect would
      // replay the `Authorization: Bearer ezk_*` header to an attacker host.
      redirect: "error",
    });
    if (!res.ok || !res.body) throw new HarnessApiError(res.status, httpMethod, path, await res.text().catch(() => ""));
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
