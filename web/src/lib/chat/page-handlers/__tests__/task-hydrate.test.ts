/**
 * Unit tests for the task-panel cold-start hydration.
 *
 * `hydrateTaskSnapshot` is the plain transport half (the `$effect` wrapper
 * `attachTaskHydration` lives in the sibling `.svelte.ts` and is covered by
 * `web/e2e/task-panel-cold-start.spec.ts`, where a rune scope actually
 * exists), so these drive it directly with a stub fetch. The behaviours that matter are the ones that only show up
 * under a race: a response for a conversation the user already left, and a
 * response that was overtaken by a live bus event.
 */

import { test, expect, describe, mock } from "bun:test";
import {
  hydrateTaskSnapshot,
  type TaskHydrationHost,
  type TaskSnapshotResponse,
} from "../task-hydrate.js";

interface Applied {
  convId: string;
  payload: TaskSnapshotResponse;
  seq: number;
}

/** Build a host with a stub fetch and a recording `apply`. */
function makeHost(
  res: { ok?: boolean; json?: unknown; throws?: boolean } | (() => Promise<Response>),
  opts: { seq?: number } = {},
): { host: TaskHydrationHost; applied: Applied[]; calls: string[] } {
  const applied: Applied[] = [];
  const calls: string[] = [];

  const fetchImpl = (typeof res === "function"
    ? res
    : async (url: string) => {
        calls.push(url);
        if (res.throws) throw new Error("offline");
        return {
          ok: res.ok ?? true,
          json: async () => res.json ?? { conversationId: "conv-1", tasks: [] },
        } as Response;
      }) as unknown as typeof fetch;

  return {
    applied,
    calls,
    host: {
      convId: () => "conv-1",
      reconnectCount: () => 0,
      requestCount: () => 0,
      fetchImpl,
      seqFor: () => opts.seq ?? 0,
      apply: (convId, payload, seq) => {
        applied.push({ convId, payload, seq });
      },
    },
  };
}

describe("hydrateTaskSnapshot", () => {
  test("fetches the cold-start route and applies the response", async () => {
    const { host, applied, calls } = makeHost({
      json: { conversationId: "conv-1", tasks: [{ id: "t1" }], activeTaskId: "t1" },
    });

    const ok = await hydrateTaskSnapshot(host, "conv-1", () => true);

    expect(ok).toBe(true);
    expect(calls).toEqual(["/api/conversations/conv-1/tasks"]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.convId).toBe("conv-1");
    expect(applied[0]?.payload.activeTaskId).toBe("t1");
  });

  test("passes the live-event counter captured BEFORE the request", async () => {
    // The whole point of the guard: the reducer compares this to the
    // counter at apply time. Reading it after the await would always
    // match and the guard would never fire.
    let seq = 3;
    const { host, applied } = makeHost({ json: { tasks: [] } });
    host.seqFor = () => {
      const v = seq;
      seq += 1; // any later read returns something different
      return v;
    };

    await hydrateTaskSnapshot(host, "conv-1", () => true);

    expect(applied[0]?.seq).toBe(3);
  });

  test("does nothing for an empty conversation id", async () => {
    const { host, applied, calls } = makeHost({ json: { tasks: [] } });
    expect(await hydrateTaskSnapshot(host, "", () => true)).toBe(false);
    expect(calls).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("discards the response when the conversation is no longer current", async () => {
    const { host, applied } = makeHost({ json: { tasks: [{ id: "t1" }] } });
    expect(await hydrateTaskSnapshot(host, "conv-1", () => false)).toBe(false);
    expect(applied).toEqual([]);
  });

  test("ignores a non-OK response", async () => {
    const { host, applied } = makeHost({ ok: false });
    expect(await hydrateTaskSnapshot(host, "conv-1", () => true)).toBe(false);
    expect(applied).toEqual([]);
  });

  test("swallows a network failure — the chat page must keep working", async () => {
    const { host, applied } = makeHost({ throws: true });
    expect(await hydrateTaskSnapshot(host, "conv-1", () => true)).toBe(false);
    expect(applied).toEqual([]);
  });

  test("swallows a malformed JSON body", async () => {
    const host: TaskHydrationHost = {
      convId: () => "conv-1",
      reconnectCount: () => 0,
      requestCount: () => 0,
      seqFor: () => 0,
      apply: () => {
        throw new Error("apply must not be reached");
      },
      fetchImpl: (async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })) as unknown as typeof fetch,
    };

    expect(await hydrateTaskSnapshot(host, "conv-1", () => true)).toBe(false);
  });

  test("falls back to the global fetch when none is injected", async () => {
    const original = globalThis.fetch;
    const spy = mock(async () => ({ ok: true, json: async () => ({ tasks: [] }) }) as Response);
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const applied: Applied[] = [];
      const host: TaskHydrationHost = {
        convId: () => "conv-9",
        reconnectCount: () => 0,
        requestCount: () => 0,
        seqFor: () => 0,
        apply: (convId, payload, seq) => {
          applied.push({ convId, payload, seq });
        },
      };
      const ok = await hydrateTaskSnapshot(host, "conv-9", () => true);
      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledWith("/api/conversations/conv-9/tasks");
      expect(applied).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
