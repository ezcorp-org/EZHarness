/**
 * Phase 53.7 — fixture entrypoint for the reverse-RPC round-trip
 * regression test.
 *
 * On `ezcorp/event/run:complete`, the fixture issues a reverse-RPC
 * `runtime.conversations.getMessages` call back into the host and
 * echoes the OUTCOME (success vs JSON-RPC error code) as a notification.
 * The host test asserts that the round-trip succeeds — proving the
 * `eventDriven` + `wiringLookup` gate actually accepts event-driven
 * invocations from boot-spawned subprocesses (the bug the strict
 * `currentConversationId === null` rejection was silently masking).
 *
 * Same `Bun.stdout.writer()` pattern as `event-only-extension/entrypoint.ts`.
 */

const decoder = new TextDecoder();
let buffer = "";
const stdoutWriter = Bun.stdout.writer();
let nextRpcId = 1;
const pendingRpcs = new Map<
  number,
  { resolve: (resp: JsonRpcResponse) => void }
>();

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

async function writeFrame(frame: JsonRpcEnvelope): Promise<void> {
  stdoutWriter.write(JSON.stringify(frame) + "\n");
  await stdoutWriter.flush();
}

function callHost(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const id = nextRpcId++;
  return new Promise((resolve) => {
    pendingRpcs.set(id, { resolve });
    void writeFrame({ jsonrpc: "2.0", id, method, params });
  });
}

// Process a single inbound JSON-RPC frame. Notifications that trigger
// reverse-RPC are dispatched WITHOUT awaiting in the outer loop — the
// outer read loop must stay drained so the host's response to our own
// `callHost` can be parsed and resolve the pending promise. Awaiting
// the notification handler from the for-loop deadlocks the reverse-RPC.
async function processFrame(frame: JsonRpcEnvelope): Promise<void> {
  // Inbound RPC RESPONSE (host → us, replying to a callHost). Match
  // by id and resolve the pending promise.
  if (frame.id !== undefined && frame.method === undefined) {
    const pending = pendingRpcs.get(frame.id);
    if (pending) {
      pendingRpcs.delete(frame.id);
      pending.resolve(frame as JsonRpcResponse);
    }
    return;
  }

  // Inbound NOTIFICATION (host → us, no id). React to
  // `ezcorp/event/run:complete` by issuing a reverse-RPC that
  // exercises the conversation-scope gate.
  if (frame.method === "ezcorp/event/run:complete" && frame.id === undefined) {
    const params = frame.params ?? {};
    const conversationId = (params as { conversationId?: string }).conversationId;
    if (typeof conversationId !== "string" || !conversationId) return;

    // Reverse-RPC: ask the host for this conversation's messages.
    // Pre-fix this rejected with -32604 because the boot executor's
    // `currentConversationId` was null. With the Phase 53.7 gate
    // change + boot executor's `eventDriven: true` flag, the wiring
    // lookup matches and the RPC succeeds.
    const response = await callHost("ezcorp/invoke", {
      tool: "runtime.conversations.getMessages",
      arguments: { conversationId },
    });

    // Echo the outcome as a notification the host test can observe.
    // `success` carries the message count so the assertion proves we
    // actually got data back — not just an empty pass-through.
    if (response.error) {
      await writeFrame({
        jsonrpc: "2.0",
        method: "test/rpc-result",
        params: {
          conversationId,
          ok: false,
          code: response.error.code,
          message: response.error.message,
        },
      });
    } else {
      const result = response.result as { messages?: unknown[] } | undefined;
      const messageCount = Array.isArray(result?.messages) ? result.messages.length : -1;
      await writeFrame({
        jsonrpc: "2.0",
        method: "test/rpc-result",
        params: {
          conversationId,
          ok: true,
          messageCount,
        },
      });
    }
  }
}

async function main() {
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const frame: JsonRpcEnvelope = JSON.parse(line);
        // CRITICAL: do NOT await processFrame. Notifications that
        // perform reverse-RPC need the outer loop to keep consuming
        // stdin so the response can be parsed and resolve the pending
        // promise. Awaiting here deadlocks the reverse-RPC.
        void processFrame(frame).catch(() => undefined);
      } catch {
        // Malformed line — skip silently.
      }
    }
  }
}

main();
