/**
 * Coverage-completion tests for `src/runtime/goal-host.ts`.
 *
 * The main unit suite (`goal-host-unit.test.ts`) covers every code
 * path through the GoalHost class with injected fakes. This file
 * mops up the remaining ~16% — the **module-level default factory
 * branches** that production wires up:
 *
 *   - `readPersistedGoal` / `writePersistedGoal` / `deletePersistedGoal`
 *     (live `convQueries.getConversation` + `getDb().update(...)`).
 *   - `computeTokenSpendSinceArmed` (live SQL aggregator).
 *   - `defaultScanGoalConversations` (live SQL scan over
 *     `conversations.metadata ? 'goal'`).
 *   - `defaultPiComplete` dynamic-import path.
 *   - The `dequeuePending` default `require("./pending-messages")`.
 *   - The three subscription error catches (`onRunComplete failed`,
 *     `onRunTerminal failed`, `streamChat sync throw`).
 *
 * Strategy: mock.module() at the boundaries (db/connection,
 * db/queries/conversations, pi-ai) so we can exercise the live helper
 * bodies without needing a real PGlite.
 *
 * Pattern follows `src/__tests__/start-assignment-plumbing.test.ts`.
 */

import { test, expect, describe, mock, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Shared mock state ────────────────────────────────────────────────

interface FakeConversationRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

const convosById = new Map<string, FakeConversationRow>();
/** Every atomic metadata write the persistence helpers delegate. */
const metadataWrites: Array<{ id: string; patch: Record<string, unknown> }> = [];
const metadataDeletes: string[] = [];
let scanReturn: Array<Record<string, unknown>> = [];
let aggregateReturn: Array<Record<string, unknown>> = [];
let lastReadId = "unknown";

// The atomic merge itself is engine behaviour, asserted against a real PGlite
// in `conversation-metadata.test.ts`. Here it is a boundary: this file's whole
// point is exercising goal-host's live helper bodies without a real DB.
mock.module("../db/queries/conversation-metadata", () => ({
  mergeConversationMetadata: async (id: string, patch: Record<string, unknown>) => {
    metadataWrites.push({ id, patch });
  },
  deleteGoalMetadata: async (id: string) => {
    metadataDeletes.push(id);
  },
}));

mock.module("../db/queries/conversations", () => ({
  getConversation: async (id: string) => {
    lastReadId = id;
    return convosById.get(id) ?? null;
  },
  // Other exports we don't exercise in this file — stub them so
  // anything importing the module still resolves.
  getMessages: async (_id: string) => [],
  createMessage: async (_id: string, data: { role: string; content: string }) => ({
    id: "noop",
    role: data.role,
    content: data.content,
    conversationId: _id,
    parentMessageId: null,
    excluded: false,
    createdAt: new Date(),
  }),
  getConversationPath: async () => [],
}));

// `goal-host.ts` no longer issues a single `getDb().update(...)` — the two
// metadata writers delegate to the atomic helpers mocked above — so this fake
// is down to the one method the live bodies still use.
mock.module("../db/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      // Distinguish the FR-9 aggregate from the boot-sweep scan by
      // walking the drizzle SQL `queryChunks` array for a chunk whose
      // serialized `value` contains "SUM" (aggregate) vs. "metadata ?"
      // (scan). Drizzle's SQL nodes are cyclic, so JSON.stringify
      // would explode; we walk plain fields only.
      const chunks =
        typeof q === "object" && q !== null && "queryChunks" in q
          ? ((q as { queryChunks: Array<unknown> }).queryChunks ?? [])
          : [];
      let isAggregate = false;
      for (const c of chunks) {
        if (
          typeof c === "object" &&
          c !== null &&
          "value" in c &&
          Array.isArray((c as { value: unknown }).value)
        ) {
          const v = (c as { value: Array<unknown> }).value.join(" ");
          if (v.includes("SUM")) {
            isAggregate = true;
            break;
          }
        }
      }
      if (isAggregate) return { rows: aggregateReturn };
      return { rows: scanReturn };
    },
  }),
}));

beforeEach(() => {
  convosById.clear();
  metadataWrites.length = 0;
  metadataDeletes.length = 0;
  scanReturn = [];
  aggregateReturn = [];
});

// Dynamic-import AFTER mocks installed.
const {
  readPersistedGoal,
  writePersistedGoal,
  deletePersistedGoal,
  computeTokenSpendSinceArmed,
  GoalHost,
  EVALUATOR_FAILURE_THRESHOLD: _UNUSED, // referenced via the class
} = await import("../runtime/goal-host");
const { EventBus } = await import("../runtime/events");
import type { AgentEvents, AgentRun } from "../types";
import type { AgentExecutor } from "../runtime/executor";

void _UNUSED;

// ── Persistence helpers — live bodies ───────────────────────────────

describe("readPersistedGoal / writePersistedGoal / deletePersistedGoal", () => {
  test("readPersistedGoal: missing conv → undefined", async () => {
    expect(await readPersistedGoal("nope")).toBeUndefined();
  });

  test("readPersistedGoal: conv with no metadata → undefined", async () => {
    convosById.set("c1", { id: "c1", metadata: null });
    expect(await readPersistedGoal("c1")).toBeUndefined();
  });

  test("readPersistedGoal: conv with metadata.goal → returns it", async () => {
    const goal = { condition: "x", lastReason: null, createdAt: "2026" };
    convosById.set("c1", { id: "c1", metadata: { goal } });
    expect(await readPersistedGoal("c1")).toEqual(goal);
  });

  test("readPersistedGoal: conv with metadata but no goal key → undefined", async () => {
    convosById.set("c1", { id: "c1", metadata: { spawnDepth: 1 } });
    expect(await readPersistedGoal("c1")).toBeUndefined();
  });

  // ── write/delete are now ATOMIC, so these assert the DELEGATION ─────
  //
  // They used to assert the read-modify-write's no-op shape ("missing conv →
  // no update fires", "conv without `goal` → no update fires") and the merged
  // object handed to `.set()`. None of that exists any more: both helpers
  // issue ONE `UPDATE … metadata = COALESCE(metadata,'{}') || …` with no
  // preceding SELECT, so an unknown id is a no-op because it matches no row —
  // and there is no JS-side object to inspect. The merge semantics those tests
  // were really about (preserve siblings, delete only the named key, unknown
  // id changes nothing) are asserted against a real engine in
  // `conversation-metadata.test.ts`, where they can be checked on the stored
  // row instead of on a mock's argument.

  test("writePersistedGoal: merges ONLY the `goal` key, with no read first", async () => {
    convosById.set("c1", { id: "c1", metadata: { spawnDepth: 3, other: "keep" } });
    lastReadId = "unread-sentinel";

    await writePersistedGoal("c1", { condition: "y", lastReason: null, createdAt: "2026" });

    expect(metadataWrites).toEqual([
      { id: "c1", patch: { goal: { condition: "y", lastReason: null, createdAt: "2026" } } },
    ]);
    // The lost update came from the SELECT this no longer does.
    expect(lastReadId).toBe("unread-sentinel");
  });

  test("writePersistedGoal: an unknown conversation still issues the merge", async () => {
    // No `if (!conv) return` guard any more — the WHERE clause is the guard,
    // and it costs one statement instead of a statement plus a race.
    await writePersistedGoal("nope", { condition: "x", lastReason: null, createdAt: "2026" });

    expect(metadataWrites).toEqual([
      { id: "nope", patch: { goal: { condition: "x", lastReason: null, createdAt: "2026" } } },
    ]);
  });

  test("deletePersistedGoal: deletes the `goal` key atomically", async () => {
    convosById.set("c4", {
      id: "c4",
      metadata: { goal: { condition: "x", lastReason: null, createdAt: "z" }, spawnDepth: 7 },
    });
    lastReadId = "unread-sentinel";

    await deletePersistedGoal("c4");

    expect(metadataDeletes).toEqual(["c4"]);
    expect(lastReadId).toBe("unread-sentinel");
  });

  test("deletePersistedGoal: an unknown conversation still issues the delete", async () => {
    await deletePersistedGoal("nope");
    expect(metadataDeletes).toEqual(["nope"]);
  });
});

// ── computeTokenSpendSinceArmed — live SQL body ─────────────────────

describe("computeTokenSpendSinceArmed", () => {
  test("aggregate returns numeric total → returned as number", async () => {
    aggregateReturn = [{ total: 42 }];
    const n = await computeTokenSpendSinceArmed("c1", 1_700_000_000_000);
    expect(n).toBe(42);
  });

  test("aggregate returns string total → parsed", async () => {
    aggregateReturn = [{ total: "100" }];
    expect(await computeTokenSpendSinceArmed("c1", 1)).toBe(100);
  });

  test("aggregate returns NaN string → 0", async () => {
    aggregateReturn = [{ total: "not-a-number" }];
    expect(await computeTokenSpendSinceArmed("c1", 1)).toBe(0);
  });

  test("aggregate returns unknown type → 0", async () => {
    aggregateReturn = [{ total: { weird: true } as unknown }];
    expect(await computeTokenSpendSinceArmed("c1", 1)).toBe(0);
  });

  test("aggregate returns no rows → 0", async () => {
    aggregateReturn = [];
    expect(await computeTokenSpendSinceArmed("c1", 1)).toBe(0);
  });
});

// ── defaultScanGoalConversations + GoalHost.start integration ───────

describe("defaultScanGoalConversations (live SQL via boot sweep)", () => {
  test("filters out conversations without a valid goal payload", async () => {
    scanReturn = [
      { id: "ok1", metadata: { goal: { condition: "x", lastReason: null, createdAt: "z" } } },
      { id: "bad1", metadata: { goal: null } },
      { id: "bad2", metadata: { goal: { condition: 42 } } }, // wrong type
      { id: "bad3", metadata: null },
      { id: "ok2", metadata: { goal: { condition: "y", lastReason: null, createdAt: "z" } } },
    ];
    const bus = new EventBus<AgentEvents>();
    const executor = { streamChat: async () => ({}) } as unknown as AgentExecutor;
    const host = new GoalHost({ bus, executor });
    await host.start();
    expect(host.getRecord("ok1")?.status).toBe("active");
    expect(host.getRecord("ok2")?.status).toBe("active");
    expect(host.getRecord("bad1")).toBeUndefined();
    expect(host.getRecord("bad2")).toBeUndefined();
    expect(host.getRecord("bad3")).toBeUndefined();
    host.stop();
  });

  test("boot sweep failure is logged but does NOT throw out of start()", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = { streamChat: async () => ({}) } as unknown as AgentExecutor;
    const host = new GoalHost({
      bus,
      executor,
      scanGoalConversations: async () => {
        throw new Error("scan exploded");
      },
    });
    // Must not throw.
    await host.start();
    host.stop();
  });
});

// ── Default subscription error catches ─────────────────────────────

describe("subscription error catches", () => {
  test("onRunComplete throw is swallowed by .catch on the subscription", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = { streamChat: async () => ({}) } as unknown as AgentExecutor;
    const host = new GoalHost({
      bus,
      executor,
      readGoal: async () => {
        throw new Error("read explosion");
      },
    });
    await host.start();
    // Emitting run:complete forces onRunComplete to fire → throws →
    // .catch swallows. Test just asserts no unhandled rejection.
    bus.emit("run:complete", {
      run: { id: "r", agentName: "chat", status: "success", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 10));
    host.stop();
  });

  test("onRunTerminal (error) throw is swallowed", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = { streamChat: async () => ({}) } as unknown as AgentExecutor;
    const host = new GoalHost({
      bus,
      executor,
      readGoal: async () => {
        throw new Error("read explosion");
      },
    });
    await host.start();
    bus.emit("run:error", {
      run: { id: "r", agentName: "chat", status: "error", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "c1",
      error: "boom",
    });
    await new Promise((r) => setTimeout(r, 10));
    host.stop();
  });

  test("onRunTerminal (cancel) throw is swallowed", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = { streamChat: async () => ({}) } as unknown as AgentExecutor;
    const host = new GoalHost({
      bus,
      executor,
      readGoal: async () => {
        throw new Error("read explosion");
      },
    });
    await host.start();
    bus.emit("run:cancel", {
      run: { id: "r", agentName: "chat", status: "cancelled", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 10));
    host.stop();
  });
});

// ── streamChat sync-throw branch ───────────────────────────────────

describe("streamChat sync throw → pause record", () => {
  test("when executor.streamChat THROWS synchronously, loop pauses the goal", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = {
      streamChat: () => {
        throw new Error("sync boom");
      },
    } as unknown as AgentExecutor;

    const persistedStore = new Map<string, unknown>();
    persistedStore.set("c1", { condition: "x", lastReason: null, createdAt: "z" });
    const host = new GoalHost({
      bus,
      executor,
      readGoal: async (id: string) =>
        persistedStore.get(id) as
          | { condition: string; lastReason: string | null; createdAt: string }
          | undefined,
      writeGoal: async (id, g) => {
        persistedStore.set(id, g);
      },
      deleteGoal: async (id) => {
        persistedStore.delete(id);
      },
      getMessages: async () =>
        [
          {
            id: "m",
            conversationId: "c1",
            role: "assistant",
            content: "still working",
            thinkingContent: null,
            model: null,
            provider: null,
            usage: null,
            runId: null,
            parentMessageId: null,
            excluded: false,
            createdAt: new Date(),
          },
        ] as unknown as Awaited<
          ReturnType<typeof import("../db/queries/conversations").getMessages>
        >,
      createMessage: async (id, data) =>
        ({
          id: "x",
          conversationId: id,
          role: data.role,
          content: data.content,
          thinkingContent: null,
          model: null,
          provider: null,
          usage: null,
          runId: null,
          parentMessageId: null,
          excluded: false,
          createdAt: new Date(),
        }) as unknown as Awaited<
          ReturnType<typeof import("../db/queries/conversations").createMessage>
        >,
      computeTokenSpend: async () => 0,
      resolveModel: async () => ({ provider: "anthropic", model: "haiku", piModel: {} }),
      getCredential: async () => ({ type: "apikey", token: "k" }),
      complete: async () => ({
        content: [{ type: "text", text: '{"achieved":false,"reason":"go"}' }],
        usage: {},
        stopReason: "stop",
      }),
    });
    await host.ensureGoalRecordRehydrated("c1", false);
    const rec = host.getRecord("c1")!;
    rec.inFlightRunId = "init-run";
    await host.start();
    bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(rec.status).toBe("paused");
    host.stop();
  });

  test("when streamChat returns a rejected promise, .catch logs but does NOT pause", async () => {
    // Async rejection is logged; goal stays armed (active) with
    // inFlightRunId set so the next run:complete or terminal event
    // drives the next state change.
    const bus = new EventBus<AgentEvents>();
    const executor = {
      streamChat: async () => {
        throw new Error("async boom");
      },
    } as unknown as AgentExecutor;
    const persistedStore = new Map<string, unknown>();
    persistedStore.set("c1", { condition: "x", lastReason: null, createdAt: "z" });
    const host = new GoalHost({
      bus,
      executor,
      readGoal: async (id) =>
        persistedStore.get(id) as
          | { condition: string; lastReason: string | null; createdAt: string }
          | undefined,
      writeGoal: async (id, g) => {
        persistedStore.set(id, g);
      },
      deleteGoal: async (id) => {
        persistedStore.delete(id);
      },
      getMessages: async () =>
        [
          {
            id: "m",
            conversationId: "c1",
            role: "assistant",
            content: "still working",
            thinkingContent: null,
            model: null,
            provider: null,
            usage: null,
            runId: null,
            parentMessageId: null,
            excluded: false,
            createdAt: new Date(),
          },
        ] as unknown as Awaited<
          ReturnType<typeof import("../db/queries/conversations").getMessages>
        >,
      createMessage: async (id, data) =>
        ({
          id: "x",
          conversationId: id,
          role: data.role,
          content: data.content,
          thinkingContent: null,
          model: null,
          provider: null,
          usage: null,
          runId: null,
          parentMessageId: null,
          excluded: false,
          createdAt: new Date(),
        }) as unknown as Awaited<
          ReturnType<typeof import("../db/queries/conversations").createMessage>
        >,
      computeTokenSpend: async () => 0,
      resolveModel: async () => ({ provider: "anthropic", model: "haiku", piModel: {} }),
      getCredential: async () => ({ type: "apikey", token: "k" }),
      complete: async () => ({
        content: [{ type: "text", text: '{"achieved":false,"reason":"go"}' }],
        usage: {},
        stopReason: "stop",
      }),
    });
    await host.ensureGoalRecordRehydrated("c1", false);
    const rec = host.getRecord("c1")!;
    rec.inFlightRunId = "init-run";
    await host.start();
    bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c1",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(rec.status).toBe("active");
    expect(rec.inFlightRunId).not.toBeNull();
    host.stop();
  });
});

// ── Default dequeue + default pi-complete via dynamic import ───────

describe("default dependency wiring", () => {
  test("default dequeue path resolves `./pending-messages` without errors when no override is supplied", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = { streamChat: async () => ({}) } as unknown as AgentExecutor;
    const host = new GoalHost({ bus, executor });
    // We can't really `enqueue` without polluting other tests; just
    // assert that calling the default through start()+emit doesn't
    // crash for an UNARMED conversation (dequeue returns undefined).
    await host.start();
    bus.emit("run:complete", {
      run: { id: "r", agentName: "chat", status: "success", startedAt: 0, logs: [] } as unknown as AgentRun,
      conversationId: "no-such-conv",
    });
    await new Promise((r) => setTimeout(r, 5));
    host.stop();
  });
});

// ── invokeEvaluator default complete branch ────────────────────────
// `invokeEvaluator` is reached through the GoalHost loop using an
// injected `complete` fn; we want to also exercise the
// `defaultPiComplete` dynamic import path. Mock the pi-ai module so
// the import resolves to a controllable stub.

mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: async (
    _piModel: unknown,
    _body: unknown,
    _opts: { apiKey: string; maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ) => ({
    content: [{ type: "text", text: '{"achieved":false,"reason":"keep"}' }],
    usage: { input: 1, output: 1 },
    stopReason: "stop",
  }),
}));

describe("defaultPiComplete dynamic import", () => {
  test("default pi-ai complete is invoked when no `complete` override is supplied", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = {
      streamChat: async () => ({
        id: "next-run",
        agentName: "chat",
        status: "running",
        startedAt: 0,
        logs: [],
      }),
    } as unknown as AgentExecutor;
    const persistedStore = new Map<string, unknown>();
    persistedStore.set("c-default", { condition: "x", lastReason: null, createdAt: "z" });
    const host = new GoalHost({
      bus,
      executor,
      readGoal: async (id) =>
        persistedStore.get(id) as
          | { condition: string; lastReason: string | null; createdAt: string }
          | undefined,
      writeGoal: async (id, g) => {
        persistedStore.set(id, g);
      },
      deleteGoal: async (id) => {
        persistedStore.delete(id);
      },
      getMessages: async () =>
        [
          {
            id: "m",
            conversationId: "c-default",
            role: "assistant",
            content: "still working",
            thinkingContent: null,
            model: null,
            provider: null,
            usage: null,
            runId: null,
            parentMessageId: null,
            excluded: false,
            createdAt: new Date(),
          },
        ] as unknown as Awaited<
          ReturnType<typeof import("../db/queries/conversations").getMessages>
        >,
      createMessage: async (id, data) =>
        ({
          id: "x",
          conversationId: id,
          role: data.role,
          content: data.content,
          thinkingContent: null,
          model: null,
          provider: null,
          usage: null,
          runId: null,
          parentMessageId: null,
          excluded: false,
          createdAt: new Date(),
        }) as unknown as Awaited<
          ReturnType<typeof import("../db/queries/conversations").createMessage>
        >,
      computeTokenSpend: async () => 0,
      resolveModel: async () => ({ provider: "anthropic", model: "haiku", piModel: {} }),
      getCredential: async () => ({ type: "apikey", token: "k" }),
      // NO `complete` override → defaultPiComplete fires → dynamic
      // import resolves to the mocked pi-ai above.
    });
    await host.ensureGoalRecordRehydrated("c-default", false);
    const rec = host.getRecord("c-default")!;
    rec.inFlightRunId = "init-run";
    await host.start();
    bus.emit("run:complete", {
      run: {
        id: "init-run",
        agentName: "chat",
        status: "success",
        startedAt: 0,
        logs: [],
        provider: "anthropic",
      } as unknown as AgentRun,
      conversationId: "c-default",
    });
    await new Promise((r) => setTimeout(r, 30));
    // Achieved:false → loop re-enters streamChat with a new runId
    // (the host generates a fresh UUID; we just assert it has been
    // assigned and is NOT the initial sentinel).
    expect(rec.inFlightRunId).not.toBeNull();
    expect(rec.inFlightRunId).not.toBe("init-run");
    host.stop();
  });
});

// ── invokeEvaluator throw branch ───────────────────────────────────

describe("invokeEvaluator throw → parseFailed:true", () => {
  test("when `complete` throws (timeout etc.), evaluator counts as a failure", async () => {
    const { invokeEvaluator } = await import("../runtime/goal-host");
    const r = await invokeEvaluator(
      { provider: "anthropic", model: "haiku", piModel: {}, credential: { type: "apikey", token: "k" } },
      "do x",
      [],
      {
        complete: async () => {
          throw new Error("timeout");
        },
      },
    );
    expect(r.response.parseFailed).toBe(true);
    expect(r.response.achieved).toBe(false);
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
  });
});
