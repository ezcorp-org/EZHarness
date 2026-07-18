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
import { withToolContext, getToolContext } from "./tool-context";

const DEFAULT_TIMEOUT_MS = 30_000;

// Phase 3 chunked-frame caps (mirrors host's json-rpc.ts).
const STREAM_CHUNK_MAX_BYTES = 256 * 1024;
const STREAM_TOTAL_CAP = 100 * 1024 * 1024;
// Base64 inflates ~33%, so a 256KB raw chunk → ~341,336 base64 chars.
// Match the host's pre-decode guard so the rejection fires before
// `atob()` allocates.
const STREAM_CHUNK_MAX_B64 = (STREAM_CHUNK_MAX_BYTES * 4) / 3 + 4;

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
      // Echo the host-issued reverse-RPC correlation token. The host
      // resolves the call's real provenance ({onBehalfOf, conversationId,
      // runId, parentCallId}) from this opaque token — the subprocess
      // only passes it through, it cannot manufacture identity. The
      // token rides on `_meta.ezCallId`, merged so a caller that already
      // set `_meta` keeps its other fields.
      const callId = getToolContext()?.callId;
      let outParams = params;
      if (typeof callId === "string" && callId.length > 0) {
        const base =
          params && typeof params === "object"
            ? (params as Record<string, unknown>)
            : {};
        const existingMeta =
          base._meta && typeof base._meta === "object"
            ? (base._meta as Record<string, unknown>)
            : {};
        outParams = { ...base, _meta: { ...existingMeta, ezCallId: callId } };
      }
      const frame: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(outParams !== undefined ? { params: outParams as Record<string, unknown> } : {}),
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

  // Phase 3 chunked-frame state (host → SDK only). Mirror of the
  // host's json-rpc.ts streaming protocol.
  //
  // Symmetric to host json-rpc.ts:
  //   • announce ≤ 100MB worth of chunks (rejected up-front).
  //   • each chunk's base64 payload ≤ 256KB * 4/3 + 4 (post-encoding
  //     upper bound for a 256KB raw chunk).
  //   • assembled bytes ≤ 100MB hard cap.
  //   • seq must equal nextSeq AND seq < total.
  private streams = new Map<number | string, { total: number; pieces: string[]; nextSeq: number; assembledBytes: number }>();

  private async runLoop(): Promise<void> {
    for await (const rawLine of this.stdin) {
      if (this.stopped) break;
      // Phase 3: route on the FIRST byte. Sentinel `\x01` (chunk),
      // `\x02` (announce), `\x03` (cancel) for streamed responses;
      // anything else is the legacy line-delimited JSON path.
      if (rawLine.length === 0) continue;
      const first = rawLine.charCodeAt(0);
      if (first === 0x01) {
        this.handleChunkFrame(rawLine);
        continue;
      }
      if (first === 0x02) {
        this.handleAnnounceFrame(rawLine);
        continue;
      }
      if (first === 0x03) {
        this.handleCancelFrame(rawLine);
        continue;
      }
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

  // ── Chunked-frame protocol (host → SDK) ─────────────────────────

  private handleAnnounceFrame(line: string): void {
    const body = line.slice(1);
    const colon = body.indexOf(":");
    if (colon === -1) return;
    const idRaw = body.slice(0, colon);
    const totalRaw = body.slice(colon + 1);
    const id = parseRpcId(idRaw);
    const total = Number(totalRaw);
    if (id === null || !Number.isFinite(total) || total <= 0) return;

    // Hard cap @ 100MB / 256KB per chunk = 410 chunks
    const HARD = (100 * 1024 * 1024) / (256 * 1024);
    if (total > HARD) {
      const entry = this.pending.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new Error(
            `[@ezcorp/sdk] streaming response exceeds 100MB cap (announced ${total} chunks)`,
          ),
        );
      }
      return;
    }

    this.streams.set(id, {
      total,
      pieces: new Array(total),
      nextSeq: 0,
      assembledBytes: 0,
    });
  }

  private handleChunkFrame(line: string): void {
    const body = line.slice(1);
    const c1 = body.indexOf(":");
    if (c1 === -1) return;
    const c2 = body.indexOf(":", c1 + 1);
    if (c2 === -1) return;
    const idRaw = body.slice(0, c1);
    const seqRaw = body.slice(c1 + 1, c2);
    const b64 = body.slice(c2 + 1);
    const id = parseRpcId(idRaw);
    const seq = Number(seqRaw);
    if (id === null || !Number.isFinite(seq) || seq < 0) return;

    const state = this.streams.get(id);
    if (!state) return;

    // M3 (validator should-fix #3): symmetric defense-in-depth with
    // the host's json-rpc.ts. Even though the host is "trusted", a
    // bug there shouldn't OOM the extension subprocess.

    // M3a — oversized base64 payload: reject before atob() inflates.
    if (b64.length > STREAM_CHUNK_MAX_B64) {
      this.streams.delete(id);
      const entry = this.pending.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new Error(
            `[@ezcorp/sdk] streaming chunk exceeds 256KB cap (id=${id}, seq=${seq}, ${b64.length} b64 chars)`,
          ),
        );
      }
      return;
    }

    if (seq !== state.nextSeq) {
      this.streams.delete(id);
      const entry = this.pending.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new Error(
            `[@ezcorp/sdk] streaming chunk out of order: id=${id}, expected seq=${state.nextSeq}, got ${seq}`,
          ),
        );
      }
      return;
    }

    // M3b — seq beyond announced total: reject (mirrors host line 252-265).
    if (seq >= state.total) {
      this.streams.delete(id);
      const entry = this.pending.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new Error(
            `[@ezcorp/sdk] streaming chunk seq=${seq} exceeds announced total=${state.total} (id=${id})`,
          ),
        );
      }
      return;
    }

    let piece: string;
    try {
      piece = atob(b64);
    } catch {
      this.streams.delete(id);
      const entry = this.pending.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error(`[@ezcorp/sdk] streaming chunk invalid base64 (id=${id}, seq=${seq})`));
      }
      return;
    }
    state.pieces[seq] = piece;
    state.nextSeq = seq + 1;
    state.assembledBytes += piece.length;

    // M3c — running total exceeds 100MB cap (mirrors host line 287-299).
    if (state.assembledBytes > STREAM_TOTAL_CAP) {
      this.streams.delete(id);
      const entry = this.pending.get(id);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new Error(
            `[@ezcorp/sdk] streaming response exceeds 100MB cap (id=${id}, assembled=${state.assembledBytes})`,
          ),
        );
      }
      return;
    }

    if (state.nextSeq === state.total) {
      this.streams.delete(id);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(state.pieces.join("")) as Record<string, unknown>;
      } catch (e) {
        const entry = this.pending.get(id);
        if (entry) {
          if (entry.timer) clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(
            new Error(
              `[@ezcorp/sdk] streaming response is not valid JSON (id=${id}): ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
        return;
      }
      this.handleResponse(parsed);
    }
  }

  private handleCancelFrame(line: string): void {
    const body = line.slice(1);
    const colon = body.indexOf(":");
    const idRaw = colon === -1 ? body : body.slice(0, colon);
    const reason = colon === -1 ? "unknown" : body.slice(colon + 1);
    const id = parseRpcId(idRaw);
    if (id === null) return;
    const hadStream = this.streams.delete(id);
    const entry = this.pending.get(id);
    if (!entry && !hadStream) return;
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error(`[@ezcorp/sdk] streaming response cancelled: ${reason}`));
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

    // Central reverse-RPC provenance wrap. Every inbound host→subprocess
    // method (tools/call, ezcorp/schedule-fire, lifecycle/*,
    // ezcorp/event/*, …) carries the host-issued `_meta.ezCallId`. Bind
    // it on the tool-context ALS here — once, in the single chokepoint —
    // so any reverse-RPC the handler makes echoes the token back without
    // each handler re-implementing the plumbing. `withToolContext`
    // merges, so the inner `tools/call` wrap still adds {toolName,
    // conversationId} on top.
    const callId = extractEzCallId(params);

    // Notification: no id → no response frame.
    if (!hasId) {
      if (handler) {
        try {
          await withToolContext({ callId }, () => handler(params));
        } catch { /* swallow — notifications are fire-and-forget */ }
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
      const result = await withToolContext({ callId }, () => handler(params));
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

// ── Phase 3 streaming helpers ───────────────────────────────────

/**
 * Parse a JSON-RPC id string. Numeric forms become numbers (matching
 * the request.id sent by `request()`); non-numeric strings pass through.
 */
function parseRpcId(raw: string): number | string | null {
  if (raw.length === 0) return null;
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Pull the host-issued reverse-RPC correlation token off an inbound
 * frame's `params._meta.ezCallId`. Returns `undefined` for any shape
 * that doesn't carry one (older host, tests, malformed) — the host then
 * treats the reverse-RPC as unresolved and fails it fast rather than
 * hanging.
 */
function extractEzCallId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const id = (meta as Record<string, unknown>).ezCallId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
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
  // `process.stdout.write` triggers Bun's lazy lookup of `node:fs`'s
  // WriteStream constructor for stdio init. Phase 3 sandbox-preload
  // poisons fs module property access, so the very first stdout write
  // would throw `Extension sandbox: 'fs module' blocked`. `Bun.stdout`
  // is a stable Bun primitive (not gated by Phase 3 fs poisoning), so
  // its writer survives the sandbox. Cached lazily so we don't pay
  // the writer-creation cost on every JSON-RPC frame.
  let writer: ReturnType<typeof Bun.stdout.writer> | null = null;
  return new HostChannelImpl({
    stdin: bunStdinLines(),
    stdout: {
      write: (s: string): void => {
        if (!writer) writer = Bun.stdout.writer();
        writer.write(s);
        // Best-effort flush — if Bun's writer queue blocks we just
        // back-pressure the next call rather than awaiting here (the
        // host reader is line-delimited, so byte-aligned framing is
        // preserved by writer's internal buffering).
        void writer.flush();
      },
    },
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
      // The host resolves the conversation's active project root
      // (`conversations.projectId` → `projects.path`) and forwards it here
      // so filesystem-scoping extensions target the RIGHT project — the
      // single persistent subprocess serves every conversation, so a
      // process-wide env var would be wrong. Absent for out-of-band or
      // project-less conversations; `undefined` leaves it off the ctx.
      const ezProjectRoot =
        typeof rawMeta.ezProjectRoot === "string" && rawMeta.ezProjectRoot.length > 0
          ? rawMeta.ezProjectRoot
          : undefined;
      return withToolContext(
        { toolName: name, conversationId: ezConversationId, projectRoot: ezProjectRoot },
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

/**
 * @internal — test-only. Force-reinstalls the genuine channel dispatcher
 * register (the `ensureDispatcherRegistered` closure) onto rpc.ts, even if a
 * prior test mutated `_register` (e.g. set it to a no-op in teardown). The
 * bundled SDK shard runs test files in one process, so the module-level
 * dispatcher state leaks across files; tests that assert against the REAL
 * channel-installed register call this first to pin it deterministically.
 */
export function __rearmDispatcherForTests(): void {
  _dispatcherRegistered = false;
  ensureDispatcherRegistered();
}

/** Drops the singleton and rejects any outstanding pending requests. */
export function __resetChannelForTests(): void {
  if (singleton) {
    singleton.stop();
    singleton._clearPending("channel reset");
  }
  singleton = null;
}
