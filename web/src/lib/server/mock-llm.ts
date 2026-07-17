/**
 * Deterministic mock-LLM store + OpenAI chat-completions chunk emitter.
 *
 * The remote-test harness seeds a SCRIPT (an ordered list of turns) under a
 * stable key, then drives a conversation with `provider:"ezcorp-mock"`,
 * `model:"mock:<key>"`. pi-ai's HTTP client POSTs to our in-process
 * `/api/__test/mock-llm/v1/chat/completions` endpoint; that handler pulls
 * the next scripted turn for `<key>` (taken from `model`) and replays it as
 * a standard OpenAI streaming response. Everything downstream (pi-agent
 * tool loop, permission gates, runtime SSE, persistence) runs unchanged —
 * only the LLM's HTTP boundary is faked.
 *
 * Module-level state is a per-process singleton shared by the completions
 * route and the `/script` seed route.
 */

export interface MockToolCall {
  /** Optional explicit tool-call id; defaults to `call_<index>`. */
  id?: string;
  name: string;
  /** Args as an object (JSON-encoded for the wire) or a raw JSON string. */
  arguments?: Record<string, unknown> | string;
}

/**
 * Synthetic token usage for a turn. Lets a harness assert cache hit/miss
 * behaviour (WS0 meter, WS1 cache-survives-trim proof) WITHOUT a real
 * provider. The values map 1:1 onto pi-ai's parsed `AssistantMessage.usage`
 * (which then flows through `ctx.totalUsage` + the `run:usage` bus event):
 * `cacheRead` → `prompt_tokens_details.cached_tokens`, `cacheWrite` →
 * `prompt_tokens_details.cache_write_tokens`, `input` → the non-cached
 * remainder, `output` → `completion_tokens`. Everything defaults to the
 * prior fixed shape (`input:0, output:1`) so unseeded turns are unchanged.
 */
export interface MockUsage {
  /** Non-cached prompt (input) tokens. Default 0. */
  input?: number;
  /** Cache-READ (hit) tokens → `prompt_tokens_details.cached_tokens`. Default 0. */
  cacheRead?: number;
  /** Cache-WRITE (creation) tokens → `prompt_tokens_details.cache_write_tokens`. Default 0. */
  cacheWrite?: number;
  /** Completion (output) tokens. Default 1. */
  output?: number;
}

/**
 * A deterministic provider FAILURE for a turn. Lets a harness exercise a
 * retry/failover loop (WS2) without a real outage. Two mutually-exclusive
 * shapes, both failing PRE-first-token:
 *   - `status` (400–599): the endpoint replies with an OpenAI-shaped error
 *     body at that HTTP status, so pi-ai's SDK raises its typed error
 *     (429 = rate-limit, 5xx = server error). The parsed message carries
 *     `stopReason:"error"` with the status in `errorMessage`.
 *   - `kind:"connection"`: the response body is aborted before any token —
 *     a transport-style failure with no usable stream (models a dropped /
 *     refused connection). pi-ai fails pre-first-token as well.
 * Because faults are just turns in the FIFO, a `[fault, success]` script
 * fails the first attempt and succeeds on retry — deterministic failover.
 */
export interface MockFault {
  /** HTTP error status to fail with (429, 500, 502, 503, …). */
  status?: number;
  /** Non-HTTP transport failure: abort the body before any token streams. */
  kind?: "connection";
  /** Optional message echoed in the OpenAI-shaped error body (status faults). */
  message?: string;
}

export interface MockTurn {
  /** Assistant text for this turn (optional — a turn may be tool-only). */
  text?: string;
  /** Tool calls the assistant makes this turn (drives the real tool loop). */
  toolCalls?: MockToolCall[];
  /** Override the finish_reason. Defaults to "tool_calls" when toolCalls are
   *  present, else "stop". Use "tool_calls" to make the agent loop iterate. */
  finishReason?: "stop" | "tool_calls" | "length";
  /** Synthetic usage (incl. cache hits/misses) reported on this turn. */
  usage?: MockUsage;
  /** Fail this turn deterministically instead of replying (retry/failover). */
  fault?: MockFault;
}

const queues = new Map<string, MockTurn[]>();

/** Replace the scripted turns for a key (idempotent test setup). */
export function setMockScript(key: string, turns: MockTurn[]): void {
  queues.set(key, [...turns]);
}

/** Pull the next scripted turn for a key (FIFO). Returns a clear sentinel
 *  stop-turn when the queue is empty/unseeded so an unscripted run is
 *  debuggable rather than hanging. */
export function dequeueMockTurn(key: string): MockTurn {
  const q = queues.get(key);
  const turn = q?.shift();
  return turn ?? { text: `[mock-llm] no scripted turn for "${key}"`, finishReason: "stop" };
}

export function clearMockScripts(): void {
  queues.clear();
}

/** Derive the script key from the request `model`. The harness sends
 *  `mock:<key>`; anything else maps to the shared "default" bucket. */
export function mockScriptKeyFromModel(model: unknown): string {
  return typeof model === "string" && model.startsWith("mock:") ? model.slice("mock:".length) : "default";
}

/** Turn a scripted turn into the OpenAI `chat.completion.chunk` objects a
 *  streaming response emits, in order. Pure — unit-tested directly. */
export function mockTurnToChunks(turn: MockTurn): unknown[] {
  const chunks: unknown[] = [];

  if (turn.text && turn.text.length > 0) {
    chunks.push({
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }],
    });
  }

  if (turn.toolCalls && turn.toolCalls.length > 0) {
    turn.toolCalls.forEach((tc, i) => {
      const args = typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? {});
      chunks.push({
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id ?? `call_${i}`,
              type: "function",
              function: { name: tc.name, arguments: args },
            }],
          },
          finish_reason: null,
        }],
      });
    });
  }

  const finish = turn.finishReason ?? (turn.toolCalls && turn.toolCalls.length > 0 ? "tool_calls" : "stop");
  chunks.push({
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage: buildChunkUsage(turn.usage),
  });

  return chunks;
}

/** Shape a turn's synthetic {@link MockUsage} into the OpenAI final-chunk
 *  `usage` object pi-ai's `parseChunkUsage` reads. `prompt_tokens` is the
 *  sum of input + cache tokens (pi-ai subtracts the cache parts back out),
 *  and `prompt_tokens_details` is only emitted when a cache value is set so
 *  a plain turn keeps its historic `{prompt_tokens:0, completion_tokens:1}`
 *  shape. Pure — unit-tested directly. */
export function buildChunkUsage(usage: MockUsage | undefined): Record<string, unknown> {
  const input = usage?.input ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  const output = usage?.output ?? 1;
  const promptTokens = input + cacheRead + cacheWrite;
  const shaped: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0 || cacheWrite > 0) {
    shaped.prompt_tokens_details = { cached_tokens: cacheRead, cache_write_tokens: cacheWrite };
  }
  return shaped;
}

/** Encode a turn as the full SSE frame sequence (chunks + terminator). */
export function mockTurnToSseFrames(turn: MockTurn): string[] {
  const frames = mockTurnToChunks(turn).map((c) => `data: ${JSON.stringify(c)}\n\n`);
  frames.push("data: [DONE]\n\n");
  return frames;
}

/** Build a streaming `Response` body for a turn (what the route returns). */
export function buildMockStreamResponse(turn: MockTurn): Response {
  const frames = mockTurnToSseFrames(turn);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Encoding": "identity",
    },
  });
}

/** Build the failing `Response` for a {@link MockFault}. A `status` fault
 *  returns an OpenAI-shaped error body at that HTTP status (the SDK raises
 *  its typed 429/5xx error); a `connection` fault aborts the body before
 *  any bytes (a transport-style pre-first-token failure). */
export function buildMockFaultResponse(fault: MockFault): Response {
  if (fault.kind === "connection") {
    const stream = new ReadableStream<Uint8Array>({
      // pull(), not start(): nothing errors until a reader attaches, and the
      // reader receives the same transport-style failure either way. NOTE:
      // this erroring-body simulation is only safe where the server runs
      // OUTSIDE a bun test process — the node-hosted determinism route
      // delivers it to the client as a mid-body transport failure. Inside a
      // bun test process, bun >= 1.3.14 reports the server-side stream error
      // as an uncaught test-level error even when the client handles the
      // abort (PR #8 runs 29589476463 + 29601137701, shard 3), so in-process
      // test servers must simulate a connection fault as a raw socket drop
      // instead — see src/__tests__/mock-llm-pi-ai.integration.test.ts.
      pull(controller) {
        controller.error(new Error("[mock-llm] simulated connection failure"));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Connection": "close" },
    });
  }
  const status = fault.status ?? 500;
  const message = fault.message ?? `[mock-llm] simulated ${status} failure`;
  return new Response(
    JSON.stringify({ error: { message, type: "mock_fault", code: `mock_${status}` } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Dispatch a dequeued turn to the right `Response`: a fault fails the call,
 *  otherwise it replays as a streamed reply. The single entry point the
 *  completions route (and the wire integration test) use. */
export function buildMockTurnResponse(turn: MockTurn): Response {
  return turn.fault ? buildMockFaultResponse(turn.fault) : buildMockStreamResponse(turn);
}
