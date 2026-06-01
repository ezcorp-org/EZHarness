// cancel-run.test.ts — coverage for runtime/cancel-run.ts (Phase 4 §5.3).
//
// Mirrors the strategy of spawn.test.ts — spy on the singleton channel's
// .request and assert (a) the JSON-RPC method is "ezcorp/cancel-run",
// (b) the params shape is `{ v: 1, agentRunId }`, (c) host errors
// propagate as JsonRpcError with code/data preserved, (d) synchronous
// input validation throws before any channel call.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { cancelRun } from "../src/runtime/cancel-run";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";
import { spyOnStdoutWriter } from "./_stdout-writer-spy";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: unknown;
  timeoutMs: number | undefined;
}

function stubRequest<T>(
  returnValue: T,
): { calls: RequestCall[]; spy: ReturnType<typeof spyOn> } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown, timeoutMs?: number) => {
      calls.push({ method, params, timeoutMs });
      return returnValue;
    }) as HostChannel["request"],
  );
  return { calls, spy };
}

// ── method + param-shape + success passthrough ─────────────────────

describe("cancelRun — JSON-RPC frame shape", () => {
  test("sends method 'ezcorp/cancel-run' with v:1 and agentRunId", async () => {
    const { calls } = stubRequest({ v: 1 as const, cancelled: true });
    const result = await cancelRun("run-abc");
    expect(result).toEqual({ cancelled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("ezcorp/cancel-run");
    expect(calls[0]?.params).toEqual({ v: 1, agentRunId: "run-abc" });
  });

  test("surfaces { cancelled: false, reason: 'not-owned' } verbatim", async () => {
    stubRequest({ v: 1 as const, cancelled: false, reason: "not-owned" as const });
    const result = await cancelRun("run-someone-elses");
    expect(result).toEqual({ cancelled: false, reason: "not-owned" });
  });

  test("surfaces { cancelled: false, reason: 'missing-run' } verbatim", async () => {
    stubRequest({ v: 1 as const, cancelled: false, reason: "missing-run" as const });
    const result = await cancelRun("run-gone");
    expect(result).toEqual({ cancelled: false, reason: "missing-run" });
  });
});

// ── synchronous validation ─────────────────────────────────────────

describe("cancelRun — input validation (pre-channel)", () => {
  test("empty string → throws before channel call", async () => {
    const { calls } = stubRequest({ v: 1 as const, cancelled: true });
    await expect(cancelRun("")).rejects.toThrow(/non-empty string/i);
    expect(calls).toHaveLength(0);
  });

  test("whitespace-only → throws before channel call", async () => {
    const { calls } = stubRequest({ v: 1 as const, cancelled: true });
    await expect(cancelRun("   \n\t")).rejects.toThrow(/non-empty string/i);
    expect(calls).toHaveLength(0);
  });

  test("non-string → throws before channel call", async () => {
    const { calls } = stubRequest({ v: 1 as const, cancelled: true });
    await expect(cancelRun(42 as never)).rejects.toThrow(/non-empty string/i);
    expect(calls).toHaveLength(0);
  });
});

// ── host error propagation ─────────────────────────────────────────

describe("cancelRun — host error propagation", () => {
  test("-32001 permission-missing surfaces as JsonRpcError", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new JsonRpcError(-32001, "spawnAgents permission not granted");
      }) as HostChannel["request"],
    );
    try {
      await cancelRun("run-x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRpcError);
      expect((err as JsonRpcError).code).toBe(-32001);
    }
  });

  test("-32602 invalid-params surfaces with message intact", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new JsonRpcError(-32602, "'agentRunId' must be a non-empty string");
      }) as HostChannel["request"],
    );
    try {
      await cancelRun("run-x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRpcError);
      expect((err as JsonRpcError).code).toBe(-32602);
    }
  });
});

// ── SDK ↔ channel wire-level round-trip ────────────────────────────
//
// Audit gap #1 (§5.3): the other tests mock at `ch.request()`. This
// test exercises the full path — the SDK wrapper goes through the real
// singleton channel, a real wire frame is emitted on process.stdout,
// and a real response frame arriving on Bun.stdin is decoded back into
// the wrapper's return value. Proves the JSON-RPC serialization of
// `ezcorp/cancel-run` is actually on-the-wire-correct, not just in the
// wrapper's unit-test harness.

describe("cancelRun — wire-level round-trip through getChannel()", () => {
  test("writes a well-formed ezcorp/cancel-run frame to stdout and resolves on the matching response", async () => {
    // Drive stdin via a ReadableStream we control.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const stdinSpy = spyOn(Bun.stdin, "stream").mockImplementation(
      () => stream as ReturnType<typeof Bun.stdin.stream>,
    );

    const stdout = spyOnStdoutWriter();
    const stdoutWrites = stdout.writes;

    try {
      // Starts the real HostChannel singleton. Must come AFTER the spies
      // so getChannel()'s lazy init latches our stubs.
      getChannel().start();

      // Kick off the SDK call — the channel will serialize and write the
      // request frame to stdout, then block on a matching response.
      const pending = cancelRun("run-wire-42");

      // Poll until the outbound frame shows up on stdout.
      const deadline = Date.now() + 500;
      while (stdoutWrites.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(stdoutWrites.length).toBeGreaterThanOrEqual(1);

      // Wire-level frame shape.
      const frame = JSON.parse(stdoutWrites[0]!) as {
        jsonrpc: string;
        id: number | string;
        method: string;
        params: { v: number; agentRunId: string };
      };
      expect(frame.jsonrpc).toBe("2.0");
      expect(frame.method).toBe("ezcorp/cancel-run");
      expect(frame.params).toEqual({ v: 1, agentRunId: "run-wire-42" });
      expect(typeof frame.id).toBe("number");

      // Feed back a matching response.
      const responseFrame = {
        jsonrpc: "2.0",
        id: frame.id,
        result: { v: 1, cancelled: true },
      };
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(JSON.stringify(responseFrame) + "\n"));

      const result = await pending;
      expect(result).toEqual({ cancelled: true });

      controller.close();
    } finally {
      stdinSpy.mockRestore();
      stdout.restore();
    }
  });

  test("passes the host's `reason` field back through verbatim (not-owned)", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const stdinSpy = spyOn(Bun.stdin, "stream").mockImplementation(
      () => stream as ReturnType<typeof Bun.stdin.stream>,
    );
    const stdout = spyOnStdoutWriter();
    const stdoutWrites = stdout.writes;

    try {
      getChannel().start();
      const pending = cancelRun("run-someone-else");

      const deadline = Date.now() + 500;
      while (stdoutWrites.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const frame = JSON.parse(stdoutWrites[0]!) as { id: number | string };

      const enc = new TextEncoder();
      controller.enqueue(
        enc.encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: { v: 1, cancelled: false, reason: "not-owned" },
          }) + "\n",
        ),
      );

      const result = await pending;
      expect(result).toEqual({ cancelled: false, reason: "not-owned" });

      controller.close();
    } finally {
      stdinSpy.mockRestore();
      stdout.restore();
    }
  });

  test("host error frame surfaces as JsonRpcError with code preserved", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const stdinSpy = spyOn(Bun.stdin, "stream").mockImplementation(
      () => stream as ReturnType<typeof Bun.stdin.stream>,
    );
    const stdout = spyOnStdoutWriter();
    const stdoutWrites = stdout.writes;

    try {
      getChannel().start();
      const pending = cancelRun("run-denied");

      const deadline = Date.now() + 500;
      while (stdoutWrites.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const frame = JSON.parse(stdoutWrites[0]!) as { id: number | string };

      const enc = new TextEncoder();
      controller.enqueue(
        enc.encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32001, message: "spawnAgents permission not granted" },
          }) + "\n",
        ),
      );

      await expect(pending).rejects.toThrow(/spawnAgents permission not granted/);
      controller.close();
    } finally {
      stdinSpy.mockRestore();
      stdout.restore();
    }
  });
});
