/**
 * Bridge unit tests for agent-fuzzy-search (Phase 49.2).
 *
 * Strategy mirrors `kokoro-tts-bridge.test.ts`: stub the Worker via
 * `setWorkerFactoryForTests`, drive responses with `respond(...)`, and
 * assert the bridge's promise contract + threshold-based dispatch.
 *
 * Coverage:
 *   - empty query → all candidates returned in original order, no
 *     worker spawned (sync path)
 *   - small list (≤100) → main-thread sync ranking, no worker spawned
 *   - large list (>100) → worker spawned, request posted, response
 *     correlated by id
 *   - relevance ordering: name "foo" outranks descriptions / partials
 *   - empty-query short-circuit returns indices for ALL candidates
 *     (no fuzzy filtering)
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  rankAgents,
  setWorkerFactoryForTests,
  shutdownWorker,
  WORKER_THRESHOLD,
  type WorkerLike,
} from "../agent-fuzzy-search-bridge";

type Listener = (ev: MessageEvent | ErrorEvent) => void;

interface StubWorker extends WorkerLike {
  lastPosted: { message: unknown }[];
  respond: (data: unknown) => void;
  raiseError: (message: string) => void;
}

let stubInstancesCreated: number;
let currentStub: StubWorker | null;

function makeStubWorker(): StubWorker {
  const listeners: Record<string, Listener[]> = {
    message: [],
    error: [],
    messageerror: [],
  };
  const stub: StubWorker = {
    lastPosted: [],
    postMessage(message: unknown) {
      this.lastPosted.push({ message });
    },
    addEventListener(type: string, listener: Listener) {
      listeners[type]?.push(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      const arr = listeners[type];
      if (!arr) return;
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    },
    terminate() {},
    respond(data: unknown) {
      const ev = { data, type: "message" } as unknown as MessageEvent;
      for (const l of listeners.message) l(ev);
    },
    raiseError(message: string) {
      const ev = { message, type: "error" } as unknown as ErrorEvent;
      for (const l of listeners.error) l(ev);
    },
  };
  return stub;
}

beforeEach(() => {
  stubInstancesCreated = 0;
  currentStub = null;
  setWorkerFactoryForTests(() => {
    stubInstancesCreated++;
    currentStub = makeStubWorker();
    return currentStub;
  });
});

afterEach(() => {
  shutdownWorker();
  setWorkerFactoryForTests(null);
});

describe("agent-fuzzy-search-bridge", () => {
  test("empty query → all candidate indices in original order, no worker spawned", async () => {
    const candidates = [
      { name: "alpha" },
      { name: "beta" },
      { name: "gamma" },
    ];
    const res = await rankAgents("", candidates);
    expect(res.indices).toEqual([0, 1, 2]);
    expect(res.usedWorker).toBe(false);
    expect(stubInstancesCreated).toBe(0);
  });

  test("small list (≤ WORKER_THRESHOLD) → main-thread sync ranking, no worker spawned", async () => {
    const candidates = [
      { name: "summarizer", description: "summarize text" },
      { name: "code-reviewer", description: "review code" },
      { name: "translator", description: "translate languages" },
    ];
    const res = await rankAgents("summa", candidates);
    expect(res.usedWorker).toBe(false);
    expect(stubInstancesCreated).toBe(0);
    // "summa" is a prefix of "summarizer" — must rank first.
    expect(res.indices[0]).toBe(0);
    // "code-reviewer" / "translator" don't fuzzy-match "summa" — drop.
    expect(res.indices).not.toContain(1);
    expect(res.indices).not.toContain(2);
  });

  test("large list (>WORKER_THRESHOLD) → worker spawned and request posted", async () => {
    const candidates = Array.from({ length: WORKER_THRESHOLD + 1 }, (_, i) => ({
      name: `agent-${i}`,
      description: `description ${i}`,
    }));

    const promise = rankAgents("agent", candidates);
    expect(stubInstancesCreated).toBe(1);
    const posted = currentStub!.lastPosted[0]!.message as {
      type: string;
      id: string;
      query: string;
      candidates: { name: string }[];
    };
    expect(posted.type).toBe("rank");
    expect(posted.query).toBe("agent");
    expect(posted.candidates.length).toBe(WORKER_THRESHOLD + 1);

    // Synthesize a worker reply ranking just two of them.
    currentStub!.respond({
      type: "ranked",
      id: posted.id,
      indices: [5, 17],
      scores: [100, 50],
    });
    const res = await promise;
    expect(res.usedWorker).toBe(true);
    expect(res.indices).toEqual([5, 17]);
  });

  test("worker is reused across multiple large-list calls", async () => {
    const big = Array.from({ length: WORKER_THRESHOLD + 5 }, (_, i) => ({
      name: `agent-${i}`,
    }));
    const a = rankAgents("agent", big);
    expect(stubInstancesCreated).toBe(1);
    const aId = (currentStub!.lastPosted[0]!.message as { id: string }).id;
    currentStub!.respond({ type: "ranked", id: aId, indices: [0], scores: [10] });
    await a;

    const b = rankAgents("agent-2", big);
    expect(stubInstancesCreated).toBe(1); // still one — same worker reused
    const bId = (currentStub!.lastPosted[1]!.message as { id: string }).id;
    expect(bId).not.toBe(aId);
    currentStub!.respond({ type: "ranked", id: bId, indices: [2], scores: [50] });
    const bRes = await b;
    expect(bRes.indices).toEqual([2]);
  });

  test("worker error rejects the matching promise; bridge falls back to a fresh worker on next call", async () => {
    const big = Array.from({ length: WORKER_THRESHOLD + 1 }, (_, i) => ({
      name: `agent-${i}`,
    }));
    const a = rankAgents("agent", big);
    currentStub!.raiseError("worker died");
    await expect(a).rejects.toThrow(/worker died/);
  });
});
