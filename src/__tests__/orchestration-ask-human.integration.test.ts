/**
 * Real-subprocess integration tests for the `ask_human` tool path of
 * the `orchestration` bundled extension (Phase 5 commit 3). Spawns
 * `bun run docs/extensions/examples/orchestration/index.ts` directly,
 * drives JSON-RPC over stdio the way the host's subprocess manager
 * does, and simulates the host's `ezcorp/emit-task-event` reverse-RPC
 * plus the Phase 2c `ezcorp/event/orchestrator:human_response` push
 * that closes the two-hop bridge.
 *
 * Covers the wire-format contract between the `ask_human` handler and
 * the host without spinning up the full ExtensionRegistry / POST
 * endpoint stack (those are exercised by the E2E suite in commit 4):
 *   - `tools/call name=ask_human` round-trips through the real
 *     @ezcorp/sdk/runtime Channel + createToolDispatcher.
 *   - On call, the extension emits `orchestrator:human_input` via the
 *     `ezcorp/emit-task-event` RPC — payload carries
 *     `{ runId, conversationId, question, requestId }` exactly as §2 of
 *     the plan specifies.
 *   - A server-pushed `orchestrator:human_response` with a matching
 *     `requestId` + `conversationId` resolves the pending gate and the
 *     tool result text equals the synthetic response.
 *   - Event-delivery latency from synthetic emit → tool resolution is
 *     within the Phase 4 budget (< 500ms target; we log+warn on over,
 *     and fail at < 1000ms to give cold-start jitter headroom).
 *   - Security guard: a response with a MISMATCHED `conversationId`
 *     does not resolve the gate (dropped silently by the extension's
 *     double-check in `handleHumanResponse`).
 *   - A response with an UNKNOWN `requestId` is a no-op (early return
 *     in the handler). The test then follows up with the correct
 *     envelope to confirm the pending entry was left intact.
 *
 * Structurally mirrors `orchestration-extension.integration.test.ts`
 * (Phase 4 — the canonical template) — same spawnExtension helper,
 * same wire-host style. The orchestration extension does not use
 * storage, so there is no `wireStorageHost` counterpart.
 *
 * Abort case (plan §7.2 negative 3) is intentionally skipped here —
 * `ctx.signal` is not part of the SDK's stable `tools/call` dispatcher
 * surface (see `packages/@ezcorp/sdk/src/runtime/channel.ts:325-346`
 * — no signal is threaded from `_meta` to the handler ctx). The Phase
 * 4 integration template doesn't exercise abort either for the same
 * reason. Abort semantics are covered by the Phase 5 commit 2 unit
 * suite `orchestration-ask-human.test.ts`, which drives the handler
 * in-process with a synthetic AbortController.
 *
 * NOTE: This test spawns the extension directly from
 * docs/extensions/examples/orchestration/ — it does NOT depend on
 * `ensureBundledExtensions()` or the bundled-install path.
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
  "orchestration",
  "index.ts",
);

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  wait: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    cwd: "/home/dev/work/ez-corp-ai",
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
          try { outbound.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* closed */ }
  })();

  // Drain stderr so a wedged pipe buffer doesn't deadlock the sub.
  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try { while (true) { const { done } = await reader.read(); if (done) return; } } catch { /* */ }
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

  function kill(): void { try { proc.kill(); } catch { /* */ } }

  return { proc, outbound, inbound, wait, kill };
}

/**
 * Auto-ack `ezcorp/emit-task-event` RPCs and surface them for
 * assertion. The `ask_human` handler's fire-and-forget emit goes
 * through this RPC with `{ v: 1, type: "orchestrator:human_input",
 * payload: {...} }`. The host always answers `{ ok: true }` in
 * production — this stub mirrors that contract.
 *
 * Returns an accessor that yields the first captured
 * `orchestrator:human_input` payload, plus the raw list for tests that
 * want to count or inspect every emit.
 */
interface EmitCapture {
  humanInputPayload: () => {
    runId: string;
    conversationId: string;
    question: string;
    requestId: string;
  } | null;
  all: () => Array<Record<string, unknown>>;
}

function wireEmitTaskEventHost(p: TestProc): EmitCapture {
  const all: Array<Record<string, unknown>> = [];
  (async () => {
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (m.method !== "ezcorp/emit-task-event") continue;
        all.push(m.params as Record<string, unknown>);
        p.inbound({ jsonrpc: "2.0", id: m.id, result: { ok: true } });
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  return {
    humanInputPayload: () => {
      const hit = all.find(
        (e) => (e as { type?: string }).type === "orchestrator:human_input",
      );
      if (!hit) return null;
      return (hit as { payload: {
        runId: string;
        conversationId: string;
        question: string;
        requestId: string;
      } }).payload;
    },
    all: () => all,
  };
}

/** Push an `orchestrator:human_response` server-event into the subprocess
 *  via the Phase 2c dispatcher's JSON-RPC notification shape. Mirrors
 *  `ezcorp/event/task:assignment_update` usage in the Phase 4 template. */
function pushHumanResponse(
  p: TestProc,
  payload: { requestId: string; response: string; conversationId: string },
): void {
  p.inbound({
    jsonrpc: "2.0",
    method: "ezcorp/event/orchestrator:human_response",
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

describe("orchestration ask_human integration: real subprocess + RPC", () => {
  test("ask_human — happy path emits orchestrator:human_input, gate resolves on matching response", async () => {
    const emit = wireEmitTaskEventHost(proc!);

    proc!.inbound({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "ask_human",
        arguments: { question: "What is the meaning of life?" },
        _meta: {
          invocationMetadata: {
            runId: "run-happy",
            conversationId: "conv-ask-1",
          },
        },
      },
    });

    // 1. Wait for the extension to emit `orchestrator:human_input` via
    //    the emit-task-event RPC. The requestId is minted inside the
    //    handler; we need it to echo back in the response event.
    const emitStart = Date.now();
    const deadline = emitStart + 2000;
    let payload: ReturnType<typeof emit.humanInputPayload> = null;
    while (Date.now() < deadline) {
      payload = emit.humanInputPayload();
      if (payload) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(payload).not.toBeNull();
    expect(payload!.runId).toBe("run-happy");
    expect(payload!.conversationId).toBe("conv-ask-1");
    expect(payload!.question).toBe("What is the meaning of life?");
    expect(typeof payload!.requestId).toBe("string");
    expect(payload!.requestId.length).toBeGreaterThan(0);

    // 2. Simulate the host's POST endpoint emitting the response.
    const emittedAt = Date.now();
    pushHumanResponse(proc!, {
      requestId: payload!.requestId,
      response: "42",
      conversationId: "conv-ask-1",
    });

    // 3. Tool call resolves with the response text as the content.
    const resp = await proc!.wait((m) => m.id === 200, 5000);
    const receivedAt = Date.now();
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("42");

    // 4. Latency assertion — mirrors the Phase 4 template (< 500ms
    //    target; < 1000ms hard-fail for CI jitter headroom).
    const latency = receivedAt - emittedAt;
    expect(latency).toBeLessThan(1000);
    if (latency >= 500) {
      console.warn(
        `[orchestration-ask-human-integration] event-delivery latency ${latency}ms exceeds 500ms target`,
      );
    }
    console.log(
      `[orchestration-ask-human-integration] event-delivery latency: ${latency}ms`,
    );
  });

  test("ask_human — mismatched conversationId in response is dropped silently (gate stays open)", async () => {
    const emit = wireEmitTaskEventHost(proc!);

    proc!.inbound({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "ask_human",
        arguments: { question: "secret question" },
        _meta: {
          invocationMetadata: {
            runId: "run-mismatch",
            conversationId: "conv-ask-original",
          },
        },
      },
    });

    // Wait for the emit to confirm the handler is at the gate.
    const emitDeadline = Date.now() + 2000;
    let payload: ReturnType<typeof emit.humanInputPayload> = null;
    while (Date.now() < emitDeadline) {
      payload = emit.humanInputPayload();
      if (payload) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(payload).not.toBeNull();
    expect(payload!.conversationId).toBe("conv-ask-original");

    // Push a response with the CORRECT requestId but a DIFFERENT
    // conversationId — the extension's security double-check should
    // drop this silently.
    pushHumanResponse(proc!, {
      requestId: payload!.requestId,
      response: "attacker-controlled-payload",
      conversationId: "conv-ask-ATTACKER",
    });

    // Verify the gate stays open. Race against a sentinel timer — if
    // the tool call resolves within the window, the mismatch guard
    // failed. 300ms is long enough to let any mis-dispatched resolve
    // finish round-tripping but short enough to keep the test snappy.
    const sentinel = new Promise<"sentinel">((r) =>
      setTimeout(() => r("sentinel"), 300),
    );
    const toolResolve = proc!
      .wait((m) => m.id === 201, 400)
      .then(() => "resolved" as const)
      .catch(() => "still-pending" as const);

    const winner = await Promise.race([sentinel, toolResolve]);
    expect(winner).toBe("sentinel");

    // Belt-and-suspenders: now send the CORRECT event and assert the
    // gate does still fire (it wasn't poisoned or deleted by the bad
    // emit — the pending entry is still live).
    pushHumanResponse(proc!, {
      requestId: payload!.requestId,
      response: "after-mismatch-recovery",
      conversationId: "conv-ask-original",
    });
    const resp = await proc!.wait((m) => m.id === 201, 2000);
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("after-mismatch-recovery");
  });

  test("ask_human — unknown requestId in response is a no-op; real event still resolves the gate", async () => {
    const emit = wireEmitTaskEventHost(proc!);

    proc!.inbound({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: {
        name: "ask_human",
        arguments: { question: "pending gate" },
        _meta: {
          invocationMetadata: {
            runId: "run-unknown",
            conversationId: "conv-ask-unknown",
          },
        },
      },
    });

    const emitDeadline = Date.now() + 2000;
    let payload: ReturnType<typeof emit.humanInputPayload> = null;
    while (Date.now() < emitDeadline) {
      payload = emit.humanInputPayload();
      if (payload) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(payload).not.toBeNull();

    // First: push a response with a requestId that was never in the
    // pending map. The extension's early-return at `if (!pending) return;`
    // should swallow it — no crash, no stray tool response, no state
    // mutation.
    pushHumanResponse(proc!, {
      requestId: "00000000-0000-0000-0000-aaaaaaaaaaaa",
      response: "ghost-response",
      conversationId: "conv-ask-unknown",
    });

    // Give the dispatcher a tick to process the bogus event.
    await new Promise((r) => setTimeout(r, 100));

    // No response should have arrived for id=202 yet.
    const earlyResponses = proc!.outbound.filter((m) => m.id === 202);
    expect(earlyResponses).toHaveLength(0);

    // Now push the CORRECT event — the pending entry must still be
    // there and the gate must resolve.
    pushHumanResponse(proc!, {
      requestId: payload!.requestId,
      response: "real-response",
      conversationId: "conv-ask-unknown",
    });

    const resp = await proc!.wait((m) => m.id === 202, 2000);
    const result = resp.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe("real-response");

    // Only one response should be in flight for id=202 — a stray from
    // the unknown-id branch would show up as a duplicate.
    const allResponses = proc!.outbound.filter((m) => m.id === 202);
    expect(allResponses).toHaveLength(1);
  });
});
