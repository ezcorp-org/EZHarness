/**
 * SDK side of the per-call reverse-RPC provenance fix.
 *
 * The host stamps an opaque `_meta.ezCallId` on every inbound
 * host→subprocess frame (tools/call, schedule-fire, lifecycle/*,
 * event/*). The single `handleIncoming` chokepoint binds it on the
 * tool-context ALS so any reverse-RPC `request()` the handler makes
 * echoes the token back — the subprocess only passes it through, it
 * cannot manufacture one.
 *
 * Asserts:
 *   - reverse-RPC issued from inside an inbound handler echoes the
 *     inbound `_meta.ezCallId`,
 *   - works for non-tools/call methods too (schedule-fire) — proves the
 *     central chokepoint, not a per-handler hack,
 *   - an existing `_meta` on the reverse-RPC params is preserved
 *     (merge, not clobber),
 *   - a `request()` outside any inbound scope carries no `ezCallId`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetChannelForTests,
  createHostChannelForTests,
} from "../src/runtime/channel";

interface ControlledStdin {
  iterable: AsyncIterable<string>;
  push(line: string): void;
  close(): void;
}

function createStdin(): ControlledStdin {
  const queue: string[] = [];
  let pending: ((v: IteratorResult<string>) => void) | null = null;
  let closed = false;
  return {
    push(line) {
      if (pending) { const r = pending; pending = null; r({ value: line, done: false }); }
      else queue.push(line);
    },
    close() {
      closed = true;
      if (pending) { const r = pending; pending = null; r({ value: "", done: true }); }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            const b = queue.shift();
            if (b !== undefined) return Promise.resolve({ value: b, done: false });
            if (closed) return Promise.resolve({ value: "", done: true });
            return new Promise((res) => { pending = res; });
          },
        };
      },
    },
  };
}

function createStdout() {
  const writes: string[] = [];
  return { writes, stdout: { write: (s: string) => { writes.push(s); } } };
}

async function waitFor(cond: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function findFrame(writes: string[], method: string): Record<string, unknown> | undefined {
  for (const w of writes) {
    try {
      const m = JSON.parse(w) as Record<string, unknown>;
      if (m.method === method) return m;
    } catch { /* skip non-JSON */ }
  }
  return undefined;
}

/** All outbound request frames for `method` (concurrency assertions). */
function findFrames(writes: string[], method: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const w of writes) {
    try {
      const m = JSON.parse(w) as Record<string, unknown>;
      if (m.method === method) out.push(m);
    } catch { /* skip non-JSON */ }
  }
  return out;
}

function metaOf(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  const p = frame.params as { _meta?: unknown } | undefined;
  return p && typeof p._meta === "object" && p._meta !== null
    ? (p._meta as Record<string, unknown>)
    : undefined;
}

afterEach(() => {
  __resetChannelForTests();
});

describe("reverse-RPC ezCallId echo", () => {
  test("echoes inbound _meta.ezCallId on a reverse-RPC from a tools/call handler", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    ch.onRequest("tools/call", async () => {
      // Fire a reverse-RPC from inside the inbound-handler scope. Not
      // awaited — we only need the synchronous outbound frame write.
      void ch.request("ezcorp/llm-complete", { op: "complete" }).catch(() => {});
      return { content: [{ type: "text", text: "ok" }], isError: false };
    });

    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "probe", arguments: {}, _meta: { ezCallId: "TOKEN-XYZ" } },
    }));

    await waitFor(() => findFrame(writes, "ezcorp/llm-complete") !== undefined);
    const rev = findFrame(writes, "ezcorp/llm-complete")!;
    const params = rev.params as { _meta?: { ezCallId?: string }; op?: string };
    expect(params._meta?.ezCallId).toBe("TOKEN-XYZ");
    expect(params.op).toBe("complete"); // original params untouched
    stdin.close();
  });

  test("works for a schedule-fire notification too (central chokepoint, not per-handler)", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    ch.onRequest("ezcorp/schedule-fire", async () => {
      void ch.request("ezcorp/memory", { action: "list" }).catch(() => {});
      return undefined;
    });

    // Notification: no id. The host attaches the host-issued token on
    // `_meta` exactly like the schedule-daemon does.
    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "ezcorp/schedule-fire",
      params: { cron: "0 */6 * * *", fireId: "f1", _meta: { ezCallId: "SCHED-TOK" } },
    }));

    await waitFor(() => findFrame(writes, "ezcorp/memory") !== undefined);
    const rev = findFrame(writes, "ezcorp/memory")!;
    expect((rev.params as { _meta?: { ezCallId?: string } })._meta?.ezCallId).toBe("SCHED-TOK");
    stdin.close();
  });

  test("preserves a pre-existing _meta on the reverse-RPC params (merge, not clobber)", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    ch.onRequest("tools/call", async () => {
      void ch.request("ezcorp/storage", { _meta: { keep: "yes" }, k: "v" }).catch(() => {});
      return { content: [], isError: false };
    });

    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "p", arguments: {}, _meta: { ezCallId: "MERGE-TOK" } },
    }));

    await waitFor(() => findFrame(writes, "ezcorp/storage") !== undefined);
    const rev = findFrame(writes, "ezcorp/storage")!;
    const meta = (rev.params as { _meta?: Record<string, unknown> })._meta!;
    expect(meta.ezCallId).toBe("MERGE-TOK");
    expect(meta.keep).toBe("yes");
    stdin.close();
  });

  test("reverse-RPC outside any inbound scope carries no ezCallId", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    void ch.request("ezcorp/llm-complete", { op: "budget" }).catch(() => {});
    await waitFor(() => findFrame(writes, "ezcorp/llm-complete") !== undefined);
    const rev = findFrame(writes, "ezcorp/llm-complete")!;
    const params = rev.params as { _meta?: unknown; op?: string };
    expect(params._meta).toBeUndefined();
    expect(params.op).toBe("budget");
    stdin.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // THE core concurrency property: two inbound frames with different
  // ezCallIds, whose handlers interleave across `await`s, must each
  // echo their OWN token (ALS isolation — what a singleton can't give).
  // ─────────────────────────────────────────────────────────────────

  test("concurrent inbound frames each echo their OWN ezCallId (ALS isolation, not last-writer-wins)", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    // Handler yields the event loop BEFORE firing its reverse-RPC, so
    // the two inbound handlers are genuinely interleaved. If `callId`
    // lived in a shared mutable singleton instead of ALS, the second
    // frame's token would clobber the first and BOTH reverse-RPCs would
    // echo the same id.
    let release2: (() => void) | null = null;
    const gate2 = new Promise<void>((r) => { release2 = r; });

    ch.onRequest("tools/call", async (params) => {
      const tag = (params as { arguments?: { tag?: string } }).arguments?.tag;
      if (tag === "first") {
        // Wait until the SECOND frame has entered its handler so the
        // scopes provably overlap, then fire.
        await gate2;
      } else {
        release2?.();
        await Promise.resolve(); // hop the microtask queue
      }
      void ch.request("ezcorp/memory", { tag }).catch(() => {});
      return { content: [], isError: false };
    });

    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "p", arguments: { tag: "first" }, _meta: { ezCallId: "TOK-1" } },
    }));
    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "p", arguments: { tag: "second" }, _meta: { ezCallId: "TOK-2" } },
    }));

    await waitFor(() => findFrames(writes, "ezcorp/memory").length >= 2);
    const frames = findFrames(writes, "ezcorp/memory");
    const byTag = new Map<string, string | undefined>();
    for (const f of frames) {
      const p = f.params as { tag?: string };
      byTag.set(p.tag ?? "", metaOf(f)?.ezCallId as string | undefined);
    }
    // Each reverse-RPC echoed the token of ITS OWN inbound scope.
    expect(byTag.get("first")).toBe("TOK-1");
    expect(byTag.get("second")).toBe("TOK-2");
    expect(byTag.get("first")).not.toBe(byTag.get("second"));
    stdin.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // Inbound frame with NO _meta: reverse-RPC has no ezCallId, and any
  // _meta the reverse-RPC sets itself is preserved untouched.
  // ─────────────────────────────────────────────────────────────────

  test("inbound frame with NO _meta → reverse-RPC has no ezCallId; its own pre-set _meta survives", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    ch.onRequest("tools/call", async () => {
      void ch.request("ezcorp/storage", { _meta: { mine: "kept" }, k: "v" }).catch(() => {});
      return { content: [], isError: false };
    });

    // No _meta at all on the inbound frame (older host / edge path).
    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "p", arguments: {} },
    }));

    await waitFor(() => findFrame(writes, "ezcorp/storage") !== undefined);
    const rev = findFrame(writes, "ezcorp/storage")!;
    const meta = metaOf(rev)!;
    // No token was bound, so none is injected …
    expect("ezCallId" in meta).toBe(false);
    // … and the reverse-RPC's own _meta is left exactly as the handler
    // set it (no clobber, no spurious ezCallId:undefined key).
    expect(meta.mine).toBe("kept");
    expect((rev.params as { k?: string }).k).toBe("v");
    stdin.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // The chokepoint is method-agnostic: lifecycle/* and ezcorp/event/*
  // inbound methods propagate the token exactly like tools/call.
  // ─────────────────────────────────────────────────────────────────

  test("lifecycle/* inbound method also propagates the token (central chokepoint)", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    ch.onRequest("lifecycle/activate", async () => {
      void ch.request("ezcorp/memory", { action: "warm" }).catch(() => {});
      return { ok: true };
    });

    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "lifecycle/activate",
      params: { _meta: { ezCallId: "LIFECYCLE-TOK" } },
    }));

    await waitFor(() => findFrame(writes, "ezcorp/memory") !== undefined);
    const rev = findFrame(writes, "ezcorp/memory")!;
    expect(metaOf(rev)?.ezCallId).toBe("LIFECYCLE-TOK");
    stdin.close();
  });

  test("ezcorp/event/* inbound notification also propagates the token (central chokepoint)", async () => {
    const stdin = createStdin();
    const { writes, stdout } = createStdout();
    const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
    ch.start();

    ch.onRequest("ezcorp/event/run-complete", async () => {
      void ch.request("ezcorp/lessons", { op: "distill" }).catch(() => {});
      return undefined;
    });

    // Notification (no id) — exercises the !hasId branch of the wrap.
    stdin.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "ezcorp/event/run-complete",
      params: { runId: "r1", _meta: { ezCallId: "EVENT-TOK" } },
    }));

    await waitFor(() => findFrame(writes, "ezcorp/lessons") !== undefined);
    const rev = findFrame(writes, "ezcorp/lessons")!;
    expect(metaOf(rev)?.ezCallId).toBe("EVENT-TOK");
    stdin.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // Malformed inbound _meta must not crash the chokepoint and must not
  // produce a spurious echo (extractEzCallId hardening).
  // ─────────────────────────────────────────────────────────────────

  for (const [label, meta] of [
    ["_meta is a string", '"not-an-object"'],
    ["_meta is an array", "[1,2,3]"],
    ["_meta is null", "null"],
    ["_meta.ezCallId is a number", '{"ezCallId":42}'],
    ["_meta.ezCallId is an object", '{"ezCallId":{"nested":true}}'],
    ["_meta.ezCallId is empty string", '{"ezCallId":""}'],
  ] as const) {
    test(`malformed inbound _meta (${label}) → no echo, no crash`, async () => {
      const stdin = createStdin();
      const { writes, stdout } = createStdout();
      const ch = createHostChannelForTests({ stdin: stdin.iterable, stdout });
      ch.start();

      ch.onRequest("tools/call", async () => {
        void ch.request("ezcorp/memory", { op: "x" }).catch(() => {});
        return { content: [], isError: false };
      });

      // Hand-built JSON so we can inject otherwise-untypeable _meta shapes.
      stdin.push(
        `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"p","arguments":{},"_meta":${meta}}}`,
      );

      await waitFor(() => findFrame(writes, "ezcorp/memory") !== undefined);
      const rev = findFrame(writes, "ezcorp/memory")!;
      // No valid token → reverse-RPC carries no _meta at all (the
      // handler set none and none was injected). Crucially: no throw,
      // no `ezCallId:undefined`, no `ezCallId:42` passthrough.
      expect((rev.params as { _meta?: unknown })._meta).toBeUndefined();
      expect((rev.params as { op?: string }).op).toBe("x");
      stdin.close();
    });
  }
});
