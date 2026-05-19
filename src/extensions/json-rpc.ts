import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./types";
import { logger } from "../logger";

const log = logger.child("ext.json-rpc");

/**
 * JSON-RPC transport over newline-delimited stdio.
 * Handles buffer fragmentation and message framing.
 *
 * Phase 3 transport extension:
 *   The transport now recognizes a chunked-frame protocol for streaming
 *   large reverse-RPC responses (e.g. `ezcorp/fs.read` of a multi-MB
 *   file). Small responses keep the existing `{...}\n` line-delimited
 *   format — back-compat is preserved by a sentinel-byte disambiguation.
 *
 *   Wire shapes (one frame per line, all terminated with `\n`):
 *     announce: \x02<id>:<total-chunks>\n
 *     chunk:    \x01<id>:<seq>:<base64-data>\n
 *     cancel:   \x03<id>:<reason>\n
 *
 *   Existing legacy frames stay `{...}\n` — `{` (0x7B) never collides
 *   with the sentinel bytes. The reader inspects the FIRST byte of each
 *   line to route: legacy JSON / chunk / announce / cancel.
 *
 *   Constraints (locked per spec):
 *     - 256KB max chunk payload (post-base64)
 *     - 100MB hard cap per streaming response
 *     - Out-of-order seq: reject the streaming response
 *     - Cancel for unknown id: silent no-op
 *
 *   Outbound side: `send(request)` continues to write line-delimited
 *   frames. Sending IS only legacy. The streaming format is INBOUND
 *   only — the host never streams TO the subprocess in Phase 3
 *   (extensions stream subprocess→host for fs.read large files).
 */

// ── Transport-extension constants ──────────────────────────────────

/** Maximum bytes per chunk payload (post-base64). */
const CHUNK_MAX_BYTES = 256 * 1024;
/** Hard cap on assembled streaming response size. */
const STREAMING_TOTAL_CAP = 100 * 1024 * 1024;
/** Sentinel bytes for the chunked-frame protocol. */
const SENTINEL_CHUNK = 0x01;
const SENTINEL_ANNOUNCE = 0x02;
const SENTINEL_CANCEL = 0x03;

interface StreamingState {
  total: number;
  /** Sparse array indexed by seq; `received` tracks the next-expected seq. */
  pieces: string[];
  /** Next sequence number expected. Out-of-order arrival fails. */
  nextSeq: number;
  /** Total assembled bytes so far (post-base64-decode). */
  assembledBytes: number;
}

export class JsonRpcTransport {
  private buffer = "";
  private responseCallbacks = new Map<number | string, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();
  private streams = new Map<number | string, StreamingState>();
  private reading = false;

  /** Callback for incoming requests from the subprocess (reverse RPC). */
  onRequest?: (req: JsonRpcRequest) => void;
  /** Callback for incoming notifications from the subprocess (fire-and-forget, no id). */
  onNotification?: (notification: JsonRpcNotification) => void;

  constructor(
    private stdin: { write(data: string | Uint8Array): number; flush?(): void },
    private stdout: ReadableStream<Uint8Array>,
  ) {}

  /** Start reading responses from stdout. Call once after construction. */
  startReading(): void {
    if (this.reading) return;
    this.reading = true;
    this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = this.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // Stream closed or errored
    } finally {
      reader.releaseLock();
      this.reading = false;
      // Reject all pending callbacks
      for (const [id, cb] of this.responseCallbacks) {
        cb.reject(new Error("Transport closed"));
        this.responseCallbacks.delete(id);
      }
      // Drop any in-flight streaming buffers — readers see "Transport
      // closed" via the rejected pending callback above (the streaming
      // id always has a matching pending callback registered by send).
      this.streams.clear();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.length) continue;
      // Phase 3: route on first-byte sentinel. `{` (0x7B) never
      // collides with chunk/announce/cancel. Empty lines are skipped
      // above. A line that's only whitespace falls through to the
      // legacy parse and is silently dropped on JSON.parse failure.
      const first = line.charCodeAt(0);
      if (first === SENTINEL_CHUNK) {
        this.handleChunkFrame(line);
        continue;
      }
      if (first === SENTINEL_ANNOUNCE) {
        this.handleAnnounceFrame(line);
        continue;
      }
      if (first === SENTINEL_CANCEL) {
        this.handleCancelFrame(line);
        continue;
      }

      // Legacy line-delimited JSON path (untouched by Phase 3).
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method && msg.id != null) {
          // Incoming request from subprocess (has method + id).
          if (this.onRequest) {
            this.onRequest(msg as JsonRpcRequest);
          } else {
            // No handler wired on THIS transport. Never silently drop:
            // the child is `await`ing this reverse-RPC and would hang
            // until the 90s watchdog. Log loud + reply with an error so
            // the child rejects immediately. This makes any future
            // wiring regression fail fast & visibly instead of as a
            // silent "stuck chat".
            const req = msg as JsonRpcRequest;
            log.error(
              "inbound reverse-RPC request with NO handler wired on this transport — replying error (a subprocess was respawned without re-wiring; see ToolExecutor.ensureSubprocessRpcWired)",
              { method: req.method, id: req.id },
            );
            try {
              const errResp =
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  error: {
                    code: -32603,
                    message: `No request handler wired for "${req.method}" (subprocess transport not bound)`,
                  },
                }) + "\n";
              this.stdin.write(errResp);
              if (this.stdin.flush) this.stdin.flush();
            } catch (err) {
              log.debug("failed to write no-handler error response", {
                method: req.method,
                error: String(err),
              });
            }
          }
        } else if (msg.method && msg.id == null) {
          // JSON-RPC notification (fire-and-forget, no response expected)
          this.onNotification?.(msg as JsonRpcNotification);
        } else if (msg.id != null) {
          // Response to a previously sent request
          const cb = this.responseCallbacks.get(msg.id);
          if (cb) {
            this.responseCallbacks.delete(msg.id);
            cb.resolve(msg as JsonRpcResponse);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  // ── Streaming frame handlers (Phase 3) ────────────────────────────

  /**
   * Announce frame: `\x02<id>:<total-chunks>\n`. Initializes a
   * streaming-state entry. The id MUST match a pending response
   * callback registered by `send()` — otherwise we have nowhere to
   * deliver the assembled body.
   */
  private handleAnnounceFrame(line: string): void {
    const body = line.slice(1); // strip sentinel byte
    const colon = body.indexOf(":");
    if (colon === -1) return; // malformed; skip
    const idRaw = body.slice(0, colon);
    const totalRaw = body.slice(colon + 1);
    const id = parseId(idRaw);
    const total = Number(totalRaw);
    if (id === null || !Number.isFinite(total) || total <= 0) return;

    // Reject up-front if the announced total would exceed the per-op
    // cap. We approximate using the worst-case 256KB-per-chunk
    // raw-payload upper bound; the assembled-bytes recheck during
    // chunks catches the actual overflow if the announce undercounts.
    if (total * CHUNK_MAX_BYTES > STREAMING_TOTAL_CAP) {
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.reject(
          new Error(
            `Streaming response exceeds 100MB cap (announced ${total} chunks)`,
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

  /**
   * Chunk frame: `\x01<id>:<seq>:<base64-data>\n`. Append to the
   * streaming state, deliver when complete.
   */
  private handleChunkFrame(line: string): void {
    const body = line.slice(1);
    const c1 = body.indexOf(":");
    if (c1 === -1) return;
    const c2 = body.indexOf(":", c1 + 1);
    if (c2 === -1) return;

    const idRaw = body.slice(0, c1);
    const seqRaw = body.slice(c1 + 1, c2);
    const b64 = body.slice(c2 + 1);
    const id = parseId(idRaw);
    const seq = Number(seqRaw);
    if (id === null || !Number.isFinite(seq) || seq < 0) return;

    const state = this.streams.get(id);
    if (!state) return; // chunk for unknown stream — silent drop

    // Reject oversized chunks BEFORE base64-decoding to avoid the
    // cost of large inputs from a misbehaving extension.
    if (b64.length > CHUNK_MAX_BYTES * 4 / 3 + 4) {
      this.streams.delete(id);
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.reject(
          new Error(
            `Chunk payload exceeds 256KB cap (id=${id}, seq=${seq})`,
          ),
        );
      }
      return;
    }

    if (seq !== state.nextSeq) {
      // Out-of-order — fail fast.
      this.streams.delete(id);
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.reject(
          new Error(
            `Streaming chunk out of order: id=${id}, expected seq=${state.nextSeq}, got ${seq}`,
          ),
        );
      }
      return;
    }
    if (seq >= state.total) {
      // Sequence beyond announced total — also a failure.
      this.streams.delete(id);
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.reject(
          new Error(
            `Streaming chunk seq=${seq} exceeds announced total=${state.total} (id=${id})`,
          ),
        );
      }
      return;
    }

    // Decode base64 → string. Atob runs on the raw character data,
    // which is byte-equivalent to TextEncoder/Decoder for the
    // base64-padded ASCII subset used here.
    let piece: string;
    try {
      piece = atob(b64);
    } catch {
      this.streams.delete(id);
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.reject(new Error(`Streaming chunk has invalid base64 (id=${id}, seq=${seq})`));
      }
      return;
    }

    state.pieces[seq] = piece;
    state.nextSeq = seq + 1;
    state.assembledBytes += piece.length;

    if (state.assembledBytes > STREAMING_TOTAL_CAP) {
      this.streams.delete(id);
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.reject(
          new Error(
            `Streaming response exceeds 100MB cap (id=${id}, assembled=${state.assembledBytes})`,
          ),
        );
      }
      return;
    }

    if (state.nextSeq === state.total) {
      // All chunks received — assemble the JSON-RPC response.
      const wireStr = state.pieces.join("");
      this.streams.delete(id);
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(wireStr) as JsonRpcResponse;
      } catch (e) {
        const cb = this.responseCallbacks.get(id);
        if (cb) {
          this.responseCallbacks.delete(id);
          cb.reject(
            new Error(
              `Streaming response is not valid JSON (id=${id}): ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
        return;
      }
      const cb = this.responseCallbacks.get(id);
      if (cb) {
        this.responseCallbacks.delete(id);
        cb.resolve(parsed);
      }
    }
  }

  /**
   * Cancel frame: `\x03<id>:<reason>\n`. The remote signals it can no
   * longer fulfill the streaming response. Drop the buffer and reject
   * the pending callback. Cancel for unknown id is a silent no-op.
   */
  private handleCancelFrame(line: string): void {
    const body = line.slice(1);
    const colon = body.indexOf(":");
    const idRaw = colon === -1 ? body : body.slice(0, colon);
    const reason = colon === -1 ? "unknown" : body.slice(colon + 1);
    const id = parseId(idRaw);
    if (id === null) return;

    const hadStream = this.streams.delete(id);
    const cb = this.responseCallbacks.get(id);
    // Cancel for an id with no pending callback AND no in-flight stream
    // is the no-op case the spec calls out.
    if (!cb && !hadStream) return;
    if (cb) {
      this.responseCallbacks.delete(id);
      cb.reject(new Error(`Streaming response cancelled: ${reason}`));
    }
  }

  /** Send a JSON-RPC request and return a promise for the response. */
  send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      this.responseCallbacks.set(request.id, { resolve, reject });
      const data = JSON.stringify(request) + "\n";
      this.stdin.write(data);
      if (this.stdin.flush) this.stdin.flush();
    });
  }

  /** Cancel all pending requests. */
  close(): void {
    for (const [_id, cb] of this.responseCallbacks) {
      cb.reject(new Error("Transport closed"));
    }
    this.responseCallbacks.clear();
    this.streams.clear();
  }

  /** Encode a request to a newline-delimited JSON string. */
  static encode(request: JsonRpcRequest): string {
    return JSON.stringify(request) + "\n";
  }

  /** Decode a newline-delimited JSON string to a response. */
  static decode(line: string): JsonRpcResponse {
    return JSON.parse(line.trim());
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * JSON-RPC ids are `number | string`. Numeric stringified ids are
 * normalized to numbers to match the `responseCallbacks` map key set
 * by `send()` (which uses `request.id` directly). Non-numeric strings
 * pass through unchanged. Returns `null` for empty input.
 */
function parseId(raw: string): number | string | null {
  if (raw.length === 0) return null;
  // Pure-digit string → number (matches numeric request.id).
  if (/^[0-9]+$/.test(raw)) return Number(raw);
  return raw;
}

// ── Response builders shared across reverse-RPC handlers ────────────

/**
 * Build a JSON-RPC error response. The optional `data` field is only
 * included when defined, so this helper subsumes both the 3-arg and
 * 4-arg variants previously copy-pasted across handler files.
 */
export function rpcError(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** Build a successful JSON-RPC response. */
export function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
