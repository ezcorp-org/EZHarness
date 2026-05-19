// Unit tests for the kokoro-tts bundled extension's speak/save event
// handlers. Mirrors the structure of `ask-user/index.test.ts`:
//   - drives `_internals.handleSpeak` / `handleSave` directly (the
//     canvas wiring is exercised separately by the `start()` test that
//     swaps in a fake `createCanvas`).
//   - injects a fake reverse-RPC dispatcher via
//     `_setRpcRequestForTests` so we can assert the exact JSON-RPC
//     frames this subprocess emits without spinning up a real channel.
//
// The five behavioural cases the brief calls out:
//   1. `:speak` with selection → uses selection text + "selection" label.
//   2. `:speak` without selection → uses full content + "message" label.
//   3. `:speak` with > 4_000 chars → truncates to 4_000.
//   4. `:save` → calls `ezcorp/finalize-tool-call` with toolCallId +
//      attachmentId.
//   5. RPC failure on `:speak` → logs to stderr but doesn't throw.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  _internals,
  _setRpcRequestForTests,
  _resetRpcRequestForTests,
  _setCreateCanvasForTests,
  _resetBindingsForTests,
  start,
} from "./index";

// ── Test fakes ─────────────────────────────────────────────────────

interface RpcCall {
  method: string;
  params: unknown;
}

function makeRecorder(impl?: (call: RpcCall) => unknown) {
  const calls: RpcCall[] = [];
  _setRpcRequestForTests(async (method, params) => {
    const call = { method, params };
    calls.push(call);
    if (impl) return impl(call);
    return undefined;
  });
  return calls;
}

function getParams<T = Record<string, unknown>>(call: RpcCall): T {
  return call.params as T;
}

beforeEach(() => {
  // No global state to clear in this subprocess; the seam swap is set
  // per-test below.
});

afterEach(() => {
  _resetRpcRequestForTests();
  _resetBindingsForTests();
});

// ── 1. Speak with selection ────────────────────────────────────────

describe("kokoro-tts:speak — with selection", () => {
  test("uses the selection text and labels the new turn 'selection'", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-1",
      conversationId: "conv-1",
      content: "Full message body that should be ignored.",
      selection: "  highlighted phrase  ",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("ezcorp/append-message");
    const p = getParams<{
      conversationId: string;
      parentMessageId: string;
      role: string;
      content: string;
      excluded: boolean;
      toolCalls: Array<{
        name: string;
        input: { text: string };
        cardType: string;
        status: string;
      }>;
    }>(calls[0]!);
    expect(p.conversationId).toBe("conv-1");
    expect(p.parentMessageId).toBe("msg-1");
    expect(p.role).toBe("extension");
    expect(p.excluded).toBe(true);
    // Trim is applied; "highlighted phrase" is 18 chars.
    expect(p.content).toBe("🔊 TTS of selection (18 chars)");
    expect(p.toolCalls.length).toBe(1);
    expect(p.toolCalls[0]!.name).toBe("kokoro-tts.synthesize");
    expect(p.toolCalls[0]!.input.text).toBe("highlighted phrase");
    expect(p.toolCalls[0]!.cardType).toBe("kokoro-tts-player");
    expect(p.toolCalls[0]!.status).toBe("running");
  });
});

// ── 2. Speak without selection ─────────────────────────────────────

describe("kokoro-tts:speak — without selection", () => {
  test("falls back to full content and labels the new turn 'message'", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-2",
      conversationId: "conv-2",
      content: "Hello world.",
      selection: null,
    });
    expect(calls.length).toBe(1);
    const p = getParams<{ content: string; toolCalls: Array<{ input: { text: string } }> }>(
      calls[0]!,
    );
    expect(p.content).toBe("🔊 TTS of message (12 chars)");
    expect(p.toolCalls[0]!.input.text).toBe("Hello world.");
  });

  test("treats whitespace-only selection as no selection", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-2b",
      conversationId: "conv-2b",
      content: "Body content.",
      selection: "   \n\t   ",
    });
    const p = getParams<{ content: string; toolCalls: Array<{ input: { text: string } }> }>(
      calls[0]!,
    );
    expect(p.content).toBe("🔊 TTS of message (13 chars)");
    expect(p.toolCalls[0]!.input.text).toBe("Body content.");
  });

  test("treats omitted selection field as no selection", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-2c",
      conversationId: "conv-2c",
      content: "Plain body.",
    });
    const p = getParams<{ content: string }>(calls[0]!);
    expect(p.content).toBe("🔊 TTS of message (11 chars)");
  });
});

// ── 3. Truncation at 4_000 chars ───────────────────────────────────

describe("kokoro-tts:speak — truncation", () => {
  test("clamps content > 4_000 chars and reports the clamped length", async () => {
    const calls = makeRecorder();
    const huge = "a".repeat(5_000);
    await _internals.handleSpeak({
      messageId: "msg-3",
      conversationId: "conv-3",
      content: huge,
    });
    const p = getParams<{ content: string; toolCalls: Array<{ input: { text: string } }> }>(
      calls[0]!,
    );
    expect(p.toolCalls[0]!.input.text.length).toBe(_internals.TTS_MAX_CHARS);
    expect(p.toolCalls[0]!.input.text.length).toBe(4_000);
    expect(p.content).toBe("🔊 TTS of message (4000 chars)");
  });

  test("clamps selection > 4_000 chars too", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-3b",
      conversationId: "conv-3b",
      content: "ignored",
      selection: "x".repeat(10_000),
    });
    const p = getParams<{ content: string; toolCalls: Array<{ input: { text: string } }> }>(
      calls[0]!,
    );
    expect(p.toolCalls[0]!.input.text.length).toBe(4_000);
    expect(p.content).toBe("🔊 TTS of selection (4000 chars)");
  });
});

// ── 4. Save → finalize-tool-call ───────────────────────────────────

describe("kokoro-tts:save", () => {
  test("calls ezcorp/finalize-tool-call with toolCallId + attachmentId", async () => {
    const calls = makeRecorder();
    await _internals.handleSave({
      messageId: "msg-4",
      toolCallId: "tc-4",
      attachmentId: "att-4",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("ezcorp/finalize-tool-call");
    const p = getParams<{
      toolCallId: string;
      output: { attachmentId: string };
      status: string;
    }>(calls[0]!);
    expect(p.toolCallId).toBe("tc-4");
    expect(p.output.attachmentId).toBe("att-4");
    expect(p.status).toBe("complete");
  });

  test("drops save with empty toolCallId silently", async () => {
    const calls = makeRecorder();
    await _internals.handleSave({
      messageId: "msg-4b",
      toolCallId: "",
      attachmentId: "att-4b",
    });
    expect(calls.length).toBe(0);
  });

  test("drops save with empty attachmentId silently", async () => {
    const calls = makeRecorder();
    await _internals.handleSave({
      messageId: "msg-4c",
      toolCallId: "tc-4c",
      attachmentId: "",
    });
    expect(calls.length).toBe(0);
  });
});

// ── 5. RPC failure handling ────────────────────────────────────────

describe("kokoro-tts:speak — RPC failure", () => {
  test("logs to stderr and does NOT throw when append-message rejects", async () => {
    makeRecorder(() => {
      throw new Error("simulated transport failure");
    });
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // Bun typings: stderr.write returns a boolean; replacing with a
    // capture-fn keeps the same arity. Cast required because the
    // signature is overloaded.
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Must not throw — this is the contract.
      await _internals.handleSpeak({
        messageId: "msg-5",
        conversationId: "conv-5",
        content: "body",
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.length).toBeGreaterThan(0);
    expect(stderrChunks.join("")).toContain("simulated transport failure");
    expect(stderrChunks.join("")).toContain("[kokoro-tts] append-message failed");
  });

  test("logs to stderr and does NOT throw when finalize-tool-call rejects", async () => {
    makeRecorder(() => {
      throw new Error("simulated finalize failure");
    });
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await _internals.handleSave({
        messageId: "msg-5b",
        toolCallId: "tc-5b",
        attachmentId: "att-5b",
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderrChunks.join("")).toContain("[kokoro-tts] finalize-tool-call failed");
    expect(stderrChunks.join("")).toContain("simulated finalize failure");
  });
});

// ── 6. Input-shape guards ──────────────────────────────────────────

describe("kokoro-tts:speak — input-shape guards", () => {
  test("drops events missing messageId silently", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "",
      conversationId: "conv-6",
      content: "body",
    });
    expect(calls.length).toBe(0);
  });

  test("drops events missing conversationId silently", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-6",
      conversationId: "",
      content: "body",
    });
    expect(calls.length).toBe(0);
  });

  test("drops events with non-string content silently", async () => {
    const calls = makeRecorder();
    await _internals.handleSpeak({
      messageId: "msg-6",
      conversationId: "conv-6",
      // Force a bad type past the typed boundary.
      content: 123 as unknown as string,
    });
    expect(calls.length).toBe(0);
  });
});

// ── 7. start() wiring contract ────────────────────────────────────
//
// Locks the contract that `start()` calls `createCanvas` with the
// documented shape: cardType="kokoro-tts-player", namespace="kokoro-tts",
// and both `speak` + `save` event handlers registered. Mirrors the
// equivalent test in ask-user/index.test.ts so a regression in the
// SDK's canvas API is caught here too.

describe("kokoro-tts start() — createCanvas wiring", () => {
  test("registers both speak and save handlers under namespace 'kokoro-tts'", () => {
    const captured: Array<{ cardType: unknown; namespace: unknown; events: Record<string, unknown> }> = [];
    _setCreateCanvasForTests(((opts: {
      cardType: unknown;
      namespace: unknown;
      events: Record<string, unknown>;
    }) => {
      captured.push(opts);
      return {};
    }) as never);
    try {
      start();
    } finally {
      _resetBindingsForTests();
    }
    expect(captured.length).toBe(1);
    expect(captured[0]!.cardType).toBe("kokoro-tts-player");
    expect(captured[0]!.namespace).toBe("kokoro-tts");
    expect(typeof captured[0]!.events.speak).toBe("function");
    expect(typeof captured[0]!.events.save).toBe("function");
  });
});
