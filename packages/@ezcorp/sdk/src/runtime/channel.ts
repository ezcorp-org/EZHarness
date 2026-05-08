// ── HostChannel — JSON-RPC over stdin/stdout ────────────────────
//
// Singleton channel shared by every runtime helper that needs to talk to
// the host. Replaces the hand-rolled readline loops that every example
// extension was copy-pasting.
//
// Design:
//   - One persistent line-buffered reader over stdin (AsyncIterable<string>
//     so tests can inject synthetic streams without touching process.stdin).
//   - `pending: Map<id, { resolve, reject, timer }>` for outbound requests.
//   - `handlers: Map<method, fn>` for inbound requests / notifications.
//   - Messages framed as `JSON.stringify(msg) + "\n"` on stdout.
//
// See rpc.ts for the createToolDispatcher wiring, installed lazily by
// ensureDispatcherRegistered() on the first getChannel() call. Module
// body has zero top-level side effects — importing channel.ts for a
// type, a test helper, or __resetChannelForTests must not mutate
// rpc.ts's _register.

import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import { _setDispatcherRegister, toolError } from "./rpc";
import { withToolContext } from "./tool-context";

const DEFAULT_TIMEOUT_MS = 30_000;

// ── JsonRpcError ────────────────────────────────────────────────
//
// JSON-RPC 2.0 distinguishes two error classes:
//   - Protocol error (method/tool not found, invalid params, etc.) →
//     `{jsonrpc, id, error: {code, message, data?}}` envelope.
//   - Tool-level error (handler ran but failed) → `{jsonrpc, id,
//     result: {isError: true, content: [...]}}` envelope (MCP convention).
//
// onRequest handlers signal the protocol-error class by THROWING this
// class. `handleIncoming` recognizes it and emits the matching envelope
// with the supplied code/message instead of the default -32000 wrap.
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface HostChannel {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params: unknown): void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void;
  /** Begin the stdin read loop. Idempotent — second call is a no-op. */
  start(): void;
  /** Signal the read loop to exit on next iteration. */
  stop(): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ChannelStdio {
  stdin: AsyncIterable<string>;
  stdout: { write: (s: string) => void | Promise<void> };
}

class HostChannelImpl implements HostChannel {
  private started = false;
  private stopped = false;
  private idCounter = 0;
  private readonly pending = new Map<number | string, PendingEntry>();
  private readonly handlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
  private readonly stdin: AsyncIterable<string>;
  private readonly stdout: { write: (s: string) => void | Promise<void> };

  constructor(io: ChannelStdio) {
    this.stdin = io.stdin;
    this.stdout = io.stdout;
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    this.idCounter += 1;
    const id = this.idCounter;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`[@ezcorp/sdk] request timeout after ${timeoutMs}ms: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const frame: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params: params as Record<string, unknown> } : {}),
      };
      this.write(frame);
    });
  }

  notify(method: string, params: unknown): void {
    const frame = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(frame);
  }

  onRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown> | unknown,
  ): void {
    this.handlers.set(method, handler);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Run loop without awaiting; errors inside the loop would otherwise
    // become an unhandled rejection. Log to stderr so terminal stdin
    // errors (closed, iterator blow-up) are debuggable in prod instead
    // of silently swallowed.
    void this.runLoop().catch((err) =>
      process.stderr.write(`[HostChannel] runLoop fatal: ${err}\n`),
    );
  }

  stop(): void {
    this.stopped = true;
  }

  /** @internal — used by __resetChannelForTests. */
  _clearPending(reason: string): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private write(msg: unknown): void {
    void this.stdout.write(JSON.stringify(msg) + "\n");
  }

  private async runLoop(): Promise<void> {
    for await (const rawLine of this.stdin) {
      if (this.stopped) break;
      const line = rawLine.trim();
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Skip malformed frames — upstream may be interleaving non-JSON noise.
        continue;
      }
      if (typeof msg.method === "string") {
        // Fire-and-forget: handleIncoming is async because a tool handler
        // may do its own reverse-RPC (e.g. an ezcorp/storage round-trip).
        // Awaiting here would BLOCK the loop from reading the next line —
        // including the response frame the handler itself is waiting for,
        // deadlocking any tool that touches Storage/fs/invoke. Unhandled
        // rejections inside handleIncoming are already suppressed because
        // handleIncoming serializes errors into a response frame on the
        // line-222 / -239 paths.
        void this.handleIncoming(msg);
      } else if (msg.id !== undefined && msg.id !== null) {
        this.handleResponse(msg);
      }
    }
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const rawId = msg.id;
    if (typeof rawId !== "number" && typeof rawId !== "string") return;
    const entry = this.pending.get(rawId);
    if (!entry) return;
    this.pending.delete(rawId);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.error !== undefined) {
      const errObj = msg.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
      const message = typeof errObj?.message === "string" ? errObj.message : "rpc error";
      // Preserve structured JSON-RPC errors so callers can branch on
      // `code` / `data.reason` without string-matching. Fall back to a
      // plain Error when `code` is missing (keeps legacy behavior for
      // malformed frames where only a message came through).
      if (typeof errObj?.code === "number") {
        entry.reject(new JsonRpcError(errObj.code, message, errObj.data));
      } else {
        entry.reject(new Error(message));
      }
      return;
    }
    entry.resolve(msg.result);
  }

  private async handleIncoming(msg: Record<string, unknown>): Promise<void> {
    const method = msg.method as string;
    const rawId = msg.id;
    const hasId = typeof rawId === "number" || typeof rawId === "string";
    const params = msg.params;
    const handler = this.handlers.get(method);

    // Notification: no id → no response frame.
    if (!hasId) {
      if (handler) {
        try { await handler(params); } catch { /* swallow — notifications are fire-and-forget */ }
      }
      return;
    }

    const id = rawId as number | string;

    if (!handler) {
      const res: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
      this.write(res);
      return;
    }

    try {
      const result = await handler(params);
      const res: JsonRpcResponse = { jsonrpc: "2.0", id, result };
      this.write(res);
    } catch (err) {
      if (err instanceof JsonRpcError) {
        const error: { code: number; message: string; data?: unknown } = {
          code: err.code,
          message: err.message,
        };
        if (err.data !== undefined) error.data = err.data;
        const res: JsonRpcResponse = { jsonrpc: "2.0", id, error };
        this.write(res);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const res: JsonRpcResponse = {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      };
      this.write(res);
    }
  }
}

// ── Production stdin source ─────────────────────────────────────
//
// Bun.stdin.stream() yields Uint8Array chunks; we split on \n into an
// async iterable of lines (trailing \n stripped). A final non-terminated
// fragment is yielded when the stream closes.

async function* bunStdinLines(): AsyncGenerator<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.length > 0) yield buffer;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* reader may already be released */ }
  }
}

// ── Singleton ───────────────────────────────────────────────────

let singleton: HostChannelImpl | null = null;

function createProductionChannel(): HostChannelImpl {
  return new HostChannelImpl({
    stdin: bunStdinLines(),
    stdout: { write: (s: string): void => { process.stdout.write(s); } },
  });
}

// ── createToolDispatcher wiring ─────────────────────────────────
//
// Tells rpc.ts how to turn a handler map into an onRequest("tools/call",
// ...) registration against the singleton. Installed lazily on the first
// getChannel() call, gated by `_dispatcherRegistered` so subsequent calls
// are cheap and idempotent. Deferred (not run at module top-level) so
// `import "@ezcorp/sdk/runtime"` has no side effect on rpc.ts's _register
// — preload.ts / test-only consumers of __resetChannelForTests must not
// overwrite the default "channel not ready" throw before any test runs.
//
// Note: `__resetChannelForTests` intentionally does NOT clear this flag.
// The installed closure captures `getChannel()` lazily, so whether the
// singleton exists or not at wire time is decided per-call, not at
// registration time. Resetting the singleton is safe without re-arming.

let _dispatcherRegistered = false;

function ensureDispatcherRegistered(): void {
  if (_dispatcherRegistered) return;
  _dispatcherRegistered = true;
  _setDispatcherRegister(({ handlers, opts }) => {
    const ch = getChannel();
    ch.onRequest("tools/call", async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      const args = (p.arguments ?? {}) as Record<string, unknown>;
      // Phase 4 §5.1a: the host threads per-invocation metadata through
      // `_meta.invocationMetadata`. Surface it on the handler ctx so
      // extensions can read host-bound overrides without re-parsing
      // `_meta` themselves.
      const rawMeta = (p._meta ?? {}) as Record<string, unknown>;
      const invocationMetadata =
        rawMeta.invocationMetadata && typeof rawMeta.invocationMetadata === "object"
          ? (rawMeta.invocationMetadata as Record<string, unknown>)
          : undefined;
      const ctx = invocationMetadata ? { invocationMetadata } : {};
      const handler = handlers[name];
      // Protocol error (-32601 Method not found) for unknown tools — thrown
      // so HostChannel emits a real JSON-RPC error envelope, not an
      // isError-result. Tool-level errors (handler threw / returned
      // isError:true) keep the result-envelope path below.
      if (!handler) throw new JsonRpcError(-32601, `Tool not found: ${name}`);
      // Phase 2: bind the per-call tool context so the in-sandbox fetch
      // wrapper (sandbox-preload.ts) can read the active tool name from
      // ALS. Without this, the wrapper falls back to extension-wide
      // allowlist only — the per-tool override (`EZCORP_TOOL_NETWORK_CAPS`)
      // would be unreachable. `ezConversationId` is forwarded by the host
      // on `_meta`; default to "" when absent (e.g. in tests).
      const ezConversationId =
        typeof rawMeta.ezConversationId === "string" ? rawMeta.ezConversationId : "";
      return withToolContext(
        { toolName: name, conversationId: ezConversationId },
        async () => {
          try {
            return await handler(args, ctx);
          } catch (err) {
            if (opts?.onError) return opts.onError(err, name);
            const message = err instanceof Error ? err.message : String(err);
            return toolError(message);
          }
        },
      );
    });
  });
}

export function getChannel(): HostChannel {
  ensureDispatcherRegistered();
  if (!singleton) singleton = createProductionChannel();
  return singleton;
}

// ── Test hooks ──────────────────────────────────────────────────
//
// `createHostChannelForTests` is re-exported from runtime/index.ts — the
// `ForTests` suffix signals it is internal / non-public. Extension test
// files use it to route synthetic JSON-RPC frames through an isolated
// channel instance without poking at process.stdin/process.stdout.
// Phase 3 will partition these internals into a non-public entry before
// the SDK is published.

export function createHostChannelForTests(opts: {
  stdin: AsyncIterable<string>;
  stdout: { write: (s: string) => void | Promise<void> };
}): HostChannel {
  return new HostChannelImpl(opts);
}

/** Drops the singleton and rejects any outstanding pending requests. */
export function __resetChannelForTests(): void {
  if (singleton) {
    singleton.stop();
    singleton._clearPending("channel reset");
  }
  singleton = null;
}
