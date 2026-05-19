/**
 * Real-subprocess integration tests for the `ask-user` bundled
 * extension. Spawns `bun run docs/extensions/examples/ask-user/index.ts`
 * directly, drives JSON-RPC over stdio the way the host's subprocess
 * manager does, and pushes the `ezcorp/event/ask-user:answer`
 * notification that resolves the gate.
 *
 * Differences from `orchestration-ask-human.integration.test.ts`:
 *   • No `ezcorp/emit-task-event` RPC: the new design uses the host's
 *     existing `tool:start` event (carried via `cardType:
 *     "ask-user-question"`) for the question side, so there is no
 *     emit-task-event branch on this path. This test asserts the
 *     extension does NOT make an `ezcorp/emit-task-event` call —
 *     guarding against regression that would re-introduce the
 *     unnecessary two-hop emit.
 *   • Gate key is `toolCallId` (threaded via `_meta.invocationMetadata.
 *     toolCallId`), not a minted `requestId`.
 *
 * Covers the wire-format contract:
 *   - `tools/call name=ask_user_question` round-trips through the real
 *     @ezcorp/sdk/runtime Channel + createToolDispatcher.
 *   - A server-pushed `ask-user:answer` with matching `toolCallId` +
 *     `conversationId` resolves the gate; tool result text equals the
 *     answer.
 *   - Event-delivery latency from push → tool resolution stays under
 *     500ms (warn) / 1000ms (fail) — same Phase 4 budget the
 *     orchestration suite uses.
 *   - Mismatched `conversationId` is dropped silently (the extension's
 *     `handleAnswer` security double-check stays intact when going
 *     through the real dispatcher).
 *   - Unknown `toolCallId` is a no-op early return; the real
 *     `toolCallId`'s gate stays live and resolves on the legitimate
 *     event.
 *   - Regression: the extension must not emit
 *     `ezcorp/emit-task-event` for ask_user_question — the design
 *     deliberately avoids that RPC.
 *
 * Abort case is intentionally skipped here for the same reason the
 * orchestration suite skips it: `ctx.signal` is not yet part of the
 * SDK's stable `tools/call` dispatcher surface. Abort semantics are
 * covered by the unit suite (`docs/extensions/examples/ask-user/index.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "ask-user",
  "index.ts",
);

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  wait: (
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      EZCORP_NETWORK_ALLOWED: "0",
      EZCORP_SHELL_ALLOWED: "0",
    },
  }) as Subprocess<"pipe", "pipe", "pipe">;

  const outbound: Record<string, unknown>[] = [];
  let buffer = "";

  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            outbound.push(JSON.parse(line));
          } catch {
            /* skip non-JSON noise (e.g. shebang stderr leaks) */
          }
        }
      }
    } catch {
      /* closed */
    }
  })();

  // Drain stderr so a wedged pipe buffer doesn't deadlock the sub.
  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      /* */
    }
  })();

  function inbound(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg) + "\n";
    (proc.stdin as { write(s: string): number }).write(data);
  }

  async function wait(
    pred: (m: Record<string, unknown>) => boolean,
    ms = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = outbound.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("wait: predicate never satisfied within " + ms + "ms");
  }

  function kill(): void {
    try {
      proc.kill();
    } catch {
      /* */
    }
  }

  return { proc, outbound, inbound, wait, kill };
}

/** Push an `ask-user:answer` server-event into the subprocess via the
 *  Phase 2c dispatcher's JSON-RPC notification shape. Mirrors the
 *  `ezcorp/event/orchestrator:human_response` push the orchestration
 *  integration suite uses. */
function pushAnswer(
  p: TestProc,
  payload: { toolCallId: string; conversationId: string; answer: string },
): void {
  p.inbound({
    jsonrpc: "2.0",
    method: "ezcorp/event/ask-user:answer",
    params: payload,
  });
}

let proc: TestProc | null = null;

beforeEach(() => {
  proc = spawnExtension();
});

afterEach(() => {
  if (proc) proc.kill();
  proc = null;
});

describe("ask-user integration: real subprocess + RPC", () => {
  test("happy path — answer resolves gate keyed on toolCallId, latency under budget", async () => {
    proc!.inbound({
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: {
        name: "ask_user_question",
        arguments: { question: "Pick one", options: ["A", "B"] },
        _meta: {
          invocationMetadata: {
            toolCallId: "tc-int-1",
            conversationId: "conv-int-1",
          },
        },
      },
    });

    // Allow the handler to register the gate before pushing the answer.
    await new Promise((r) => setTimeout(r, 50));

    const emittedAt = Date.now();
    pushAnswer(proc!, {
      toolCallId: "tc-int-1",
      conversationId: "conv-int-1",
      answer: "B",
    });

    const resp = await proc!.wait((m) => m.id === 300, 5000);
    const receivedAt = Date.now();
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("B");

    const latency = receivedAt - emittedAt;
    expect(latency).toBeLessThan(1000);
    if (latency >= 500) {
      console.warn(
        `[ask-user-integration] event-delivery latency ${latency}ms exceeds 500ms target`,
      );
    }
    console.log(
      `[ask-user-integration] event-delivery latency: ${latency}ms`,
    );
  });

  test("regression — extension does NOT emit ezcorp/emit-task-event for ask_user_question", async () => {
    proc!.inbound({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: {
        name: "ask_user_question",
        arguments: { question: "Free text?" },
        _meta: {
          invocationMetadata: {
            toolCallId: "tc-int-noemit",
            conversationId: "conv-int-noemit",
          },
        },
      },
    });

    // Wait long enough for ANY emit RPC to surface — the orchestration
    // ask_human handler emits within ~50ms of the tools/call landing.
    await new Promise((r) => setTimeout(r, 200));

    const emitCalls = proc!.outbound.filter(
      (m) => m.method === "ezcorp/emit-task-event",
    );
    expect(emitCalls).toHaveLength(0);

    // Resolve the gate so the test cleanly tears down.
    pushAnswer(proc!, {
      toolCallId: "tc-int-noemit",
      conversationId: "conv-int-noemit",
      answer: "done",
    });
    const resp = await proc!.wait((m) => m.id === 301, 2000);
    expect((resp.result as { isError?: boolean }).isError).toBeFalsy();
  });

  test("mismatched conversationId is dropped silently — gate stays open", async () => {
    proc!.inbound({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: {
        name: "ask_user_question",
        arguments: { question: "Whose conv?" },
        _meta: {
          invocationMetadata: {
            toolCallId: "tc-int-sec",
            conversationId: "conv-int-original",
          },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Push answer with mismatched conversationId — should be dropped.
    pushAnswer(proc!, {
      toolCallId: "tc-int-sec",
      conversationId: "conv-int-ATTACKER",
      answer: "tampered",
    });

    // Race against a sentinel: the gate should not resolve.
    const sentinel = new Promise<"sentinel">((r) =>
      setTimeout(() => r("sentinel"), 300),
    );
    const toolResolve = proc!
      .wait((m) => m.id === 302, 400)
      .then(() => "resolved" as const)
      .catch(() => "still-pending" as const);
    const winner = await Promise.race([sentinel, toolResolve]);
    expect(winner).toBe("sentinel");

    // Push the matching answer — gate must still be alive.
    pushAnswer(proc!, {
      toolCallId: "tc-int-sec",
      conversationId: "conv-int-original",
      answer: "after-mismatch-recovery",
    });
    const resp = await proc!.wait((m) => m.id === 302, 2000);
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("after-mismatch-recovery");
  });

  test("unknown toolCallId is a no-op; real toolCallId still resolves", async () => {
    proc!.inbound({
      jsonrpc: "2.0",
      id: 303,
      method: "tools/call",
      params: {
        name: "ask_user_question",
        arguments: { question: "pending gate" },
        _meta: {
          invocationMetadata: {
            toolCallId: "tc-int-unk",
            conversationId: "conv-int-unk",
          },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Push answer with unknown toolCallId — early-return swallows it.
    pushAnswer(proc!, {
      toolCallId: "tc-int-DOES-NOT-EXIST",
      conversationId: "conv-int-unk",
      answer: "ghost",
    });

    await new Promise((r) => setTimeout(r, 100));

    const earlyResponses = proc!.outbound.filter((m) => m.id === 303);
    expect(earlyResponses).toHaveLength(0);

    pushAnswer(proc!, {
      toolCallId: "tc-int-unk",
      conversationId: "conv-int-unk",
      answer: "real-response",
    });
    const resp = await proc!.wait((m) => m.id === 303, 2000);
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("real-response");

    const allResponses = proc!.outbound.filter((m) => m.id === 303);
    expect(allResponses).toHaveLength(1);
  });
});
