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

export interface MockTurn {
  /** Assistant text for this turn (optional — a turn may be tool-only). */
  text?: string;
  /** Tool calls the assistant makes this turn (drives the real tool loop). */
  toolCalls?: MockToolCall[];
  /** Override the finish_reason. Defaults to "tool_calls" when toolCalls are
   *  present, else "stop". Use "tool_calls" to make the agent loop iterate. */
  finishReason?: "stop" | "tool_calls" | "length";
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
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });

  return chunks;
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
