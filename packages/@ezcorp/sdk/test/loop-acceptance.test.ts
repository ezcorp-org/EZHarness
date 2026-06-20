// loop-acceptance.test.ts — END-TO-END acceptance spec for `defineLoop`.
//
// This is the consolidated, scenario-named "everything works" layer for the
// Loop SDK feature. Where the sibling suites pin module internals
// (`loop-store.test.ts`, `loop-log.test.ts`, `loop-core.test.ts`) and the
// real-subprocess test (`src/__tests__/loop-primitive-subprocess.integration.test.ts`)
// proves the JSON-RPC transport, THIS file reads top-to-bottom as a
// behavioral contract: each `test` is a sentence describing an observable
// end-to-end outcome an extension author depends on.
//
// It drives the REAL facade — the real `createLoopRunStore` (per-run keys +
// withLock), the real `wireLog` artifact/dashboard helper, and the real
// state machine — through `defineLoop`. Only the channel-touching edges are
// injected (settings/messages/spawn resolvers, the fs writers, the page
// register/push seams), so the run is deterministic and needs no live pipe.
// No `Date.now`/random branch is asserted on — ids are supplied by the
// fixtures, so the suite is flake-free and order-independent.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import {
  defineLoop,
  dispatchAssignmentUpdate,
  getLoopTools,
  _getRegisteredLoop,
  __resetLoopsForTests,
  _setSettingsResolverForTests,
  _setMessagesResolverForTests,
  _setSpawnForTests,
  _setStoreFactoryForTests,
} from "../src/runtime/loop";
import {
  loopDataDir,
  _setLogFsForTests,
  _setLogPageForTests,
} from "../src/runtime/loop-log";
import { Schedule } from "../src/runtime/schedule";
import { createLoopRunStore } from "../src/runtime/loop-store";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";
import type { StorageScope } from "../src/runtime/storage";
import type { PageDefinition } from "../src/runtime/page";
import type { TaskAssignmentUpdateEvent } from "../src/runtime/host-event-types";

// ── Test rig: a per-scope in-memory KV mirroring the host's partitioning ─
//
// The host partitions Storage rows by scope (global / user / conversation).
// A faithful acceptance harness must too — otherwise the privacy scenario
// (a user run leaking into a global dashboard) cannot be observed. So the
// store factory routes each loop to a scope-keyed map; runs in different
// scopes live in PHYSICALLY separate maps, exactly as the host enforces.

function scopedStoreFactory() {
  const maps: Record<string, Map<string, unknown>> = {
    global: new Map(),
    user: new Map(),
    conversation: new Map(),
  };
  const factory = <O,>(loopId: string, contract: { scope?: StorageScope }) => {
    const scope = contract.scope ?? "global";
    const map = maps[scope]!;
    const kv = (_s: StorageScope) => ({
      async get<T>(key: string) {
        return map.has(key)
          ? { value: map.get(key) as T, exists: true }
          : { value: null, exists: false };
      },
      async set<T>(key: string, value: T) {
        map.set(key, JSON.parse(JSON.stringify(value)));
        return { ok: true as const, sizeBytes: 0 };
      },
      async delete(key: string) {
        return { deleted: map.delete(key) };
      },
      async list() {
        return { keys: [...map.keys()] };
      },
    });
    return createLoopRunStore<O>(loopId, contract as never, kv);
  };
  return { factory, maps };
}

// Captured trigger handlers — the facade registers event handlers on the
// channel (`onRequest`) and cron handlers on `Schedule.prototype.on`. We spy
// both and invoke them directly, the same seam the sibling high-level suites
// use (a live `tools/call`/schedule-fire receiver latches process-wide, so a
// per-test onRequest spy can't observe it once a sibling file installed it).
let eventHandlers: Map<string, (p: unknown) => Promise<unknown> | unknown>;
const cronHandlers = new Map<string, (ctx: unknown) => Promise<void> | void>();

// fs + page side-effect recorders (the `log` block's observable outputs).
let fsWrites: { path: string; body: string }[];
let fsMkdirs: string[];
let pagesDefined: PageDefinition[];
let pagePushes: string[];

// Restored in afterAll: the spy patches the SHARED Schedule.prototype, so
// leaving it installed poisons sibling files in the bundled SDK shard (notably
// schedule.test.ts, whose real on()/installReceiver() would never run).
let scheduleOnSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  scheduleOnSpy = spyOn(Schedule.prototype, "on").mockImplementation(function (
    this: Schedule,
    cron: string,
    handler: (ctx: unknown) => Promise<void> | void,
  ) {
    cronHandlers.set(cron, handler);
  } as Schedule["on"]);
});
afterAll(() => {
  scheduleOnSpy.mockRestore();
});

beforeEach(() => {
  cronHandlers.clear();
  __resetLoopsForTests();
  __resetChannelForTests();
  eventHandlers = new Map();
  const ch: HostChannel = getChannel();
  spyOn(ch, "onRequest").mockImplementation(((
    method: string,
    handler: (p: unknown) => unknown,
  ) => {
    eventHandlers.set(method, handler);
  }) as HostChannel["onRequest"]);

  // Default seams: empty settings + the scope-partitioned store.
  _setSettingsResolverForTests(async () => ({}));
  _setStoreFactoryForTests(scopedStoreFactory().factory as never);

  // Record the `log` block's fs + page effects.
  fsWrites = [];
  fsMkdirs = [];
  pagesDefined = [];
  pagePushes = [];
  _setLogFsForTests(
    (async (path: string, content: string | Uint8Array) => {
      fsWrites.push({ path, body: String(content) });
      return { bytes: String(content).length, resolvedPath: path };
    }) as never,
    (async (path: string) => {
      fsMkdirs.push(path);
      return { resolvedPath: path };
    }) as never,
  );
  _setLogPageForTests(
    ((def: PageDefinition) => {
      pagesDefined.push(def);
    }) as never,
    ((pageId: string) => {
      pagePushes.push(pageId);
    }) as never,
  );
});

afterEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
  _setSettingsResolverForTests(null);
  _setMessagesResolverForTests(null);
  _setSpawnForTests(null);
  _setStoreFactoryForTests(null);
  _setLogFsForTests(null, null);
  _setLogPageForTests(null, null);
});

// ── Helpers: fire a trigger the way the host would ──────────────────────

async function emitEvent(event: string, payload: unknown): Promise<void> {
  const handler = eventHandlers.get(`ezcorp/event/${event}`);
  if (!handler) throw new Error(`no event handler registered for ${event}`);
  await handler(payload);
}

async function emitCron(cron: string, catchUp = false): Promise<void> {
  const handler = cronHandlers.get(cron);
  if (!handler) throw new Error(`no cron handler registered for ${cron}`);
  await handler({
    cron,
    scheduledAt: "2026-06-18T00:00:00.000Z",
    firedAt: "2026-06-18T00:00:01.000Z",
    fireId: "fire-1",
    catchUp,
    retry: false,
    attempt: 1,
  });
}

async function callManualTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError?: boolean }> {
  const handler = getLoopTools()[name];
  if (!handler) throw new Error(`no manual loop tool registered for ${name}`);
  const res = (await handler(args)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: res.content[0]!.text, isError: res.isError };
}

/** A completion event for a deferred run, shaped like the host's. */
function completionEvent(
  taskId: string,
  assignmentId: string,
  agentRunId: string,
  status = "completed",
  resultPreview?: string,
): TaskAssignmentUpdateEvent {
  return {
    conversationId: "c1",
    taskId,
    assignment: {
      id: assignmentId,
      agentConfigId: "a",
      agentName: "coder",
      isTeam: false,
      status: status as never,
      assignedAt: "t",
      agentRunId,
      ...(resultPreview ? { resultPreview } : {}),
    },
  };
}

const CAPTURE = { states: ["done"], terminal: ["done"] } as const;
const DISPATCH = {
  states: ["dispatched", "running", "completed", "failed", "cancelled"],
  terminal: ["completed", "failed", "cancelled"],
} as const;

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Terminal capture loop (the lessons-distiller / memory-extractor
// shape): an event fires, `act` produces an outcome in one pass, and the
// primitive persists a completed run + mirrors the artifact to disk.
// ════════════════════════════════════════════════════════════════════════

describe("a terminal capture loop fires on its event and persists + mirrors its artifact", () => {
  test("a run:complete event drives one fire → a completed run + an artifact on disk", async () => {
    process.env.EZCORP_PROJECT_ROOT = "/proj";
    _setSettingsResolverForTests(async () => ({ enabled: true }));
    _setMessagesResolverForTests(async () => ({
      messages: [
        { id: "m1", role: "user", content: "ship it" },
        { id: "m2", role: "assistant", content: "done" },
      ],
      projectId: "p1",
    }));

    defineLoop<{ conversationId: string }, { summary: string }>({
      id: "distiller",
      trigger: { kind: "event", event: "run:complete" },
      contract: { ...CAPTURE, scope: "global" },
      act: async (ctx) => {
        // The author reads resolved settings + the recent-message slice and
        // returns a terminal outcome — no run-record bookkeeping written here.
        if (ctx.settings.enabled !== true) return { kind: "skip", reason: "off" };
        const recent = await ctx.recentMessages(ctx.input.conversationId);
        return {
          kind: "terminal",
          status: "done",
          outcome: { summary: `${recent.length} messages summarized` },
        };
      },
      log: {
        artifact: (run, outcome) => ({
          path: `summaries/${run.id}.md`,
          body: outcome.summary,
        }),
      },
    });

    await emitEvent("run:complete", { conversationId: "conv-1" });

    // Observable: exactly one run, terminal, carrying the outcome.
    const runs = await _getRegisteredLoop("distiller")!.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.outcome).toEqual({ summary: "2 messages summarized" });

    // Observable: the human-readable mirror was written under the loop's
    // data dir (parent mkdir'd first), and it is NOT the source of truth.
    const dir = loopDataDir("distiller");
    expect(fsMkdirs).toContain(`${dir}/summaries`);
    expect(fsWrites).toHaveLength(1);
    expect(fsWrites[0]!.path).toBe(`${dir}/summaries/${runs[0]!.id}.md`);
    expect(fsWrites[0]!.body).toBe("2 messages summarized");
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Deferred dispatch loop (the ez-code shape): `act` spawns a
// long-lived sub-agent and returns; the run stays OPEN until an inbound
// `task:assignment_update` drives it to a terminal state.
// ════════════════════════════════════════════════════════════════════════

describe("a deferred dispatch loop opens a run, then an assignment update drives it terminal", () => {
  test("act spawns + defers (run open), then a completion event closes it with the preview note", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "sub-1",
      agentRunId: "run-1",
      taskId: "task-1",
      assignmentId: "assign-1",
    }));

    defineLoop({
      id: "dispatcher",
      trigger: { kind: "event", event: "tool:complete" },
      contract: { ...DISPATCH, scope: "global" },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "build it" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
          subConversationId: h.subConversationId,
        };
      },
    });

    // Fire → the run opens at the non-terminal "dispatched" state.
    await emitEvent("tool:complete", { conversationId: "c1" });
    const store = _getRegisteredLoop("dispatcher")!.store;
    let runs = await store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("dispatched");
    expect(runs[0]!.externalRunId).toBe("run-1");

    // The host later reports completion → the deferred state machine closes
    // the run and records the result preview, with no author-written mapper.
    await dispatchAssignmentUpdate(
      completionEvent("task-1", "assign-1", "run-1", "completed", "all done"),
    );
    runs = await store.list();
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.events[0]).toMatchObject({ status: "completed", note: "all done" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Cron trigger: a scheduled fire (incl. the catch-up case) runs
// the loop and persists a run, riding the existing schedule substrate with
// no new scheduler.
// ════════════════════════════════════════════════════════════════════════

describe("a cron-triggered loop fires on its schedule and persists a run", () => {
  test("a catch-up cron tick runs act and persists a completed run carrying the catchUp flag", async () => {
    defineLoop({
      id: "sweeper",
      trigger: { kind: "cron", cron: "0 */6 * * *" },
      contract: { ...CAPTURE, scope: "global" },
      act: async (ctx) => ({
        kind: "terminal",
        status: "done",
        outcome: { catchUp: ctx.fire.catchUp },
      }),
    });

    await emitCron("0 */6 * * *", true);

    const runs = await _getRegisteredLoop("sweeper")!.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.outcome).toEqual({ catchUp: true });
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Manual trigger reachable via the merged tool dispatcher: a
// `manual` loop's tool is exposed through `getLoopTools()` (so an extension
// merges it alongside its own tools) and invoking it runs the loop.
// ════════════════════════════════════════════════════════════════════════

describe("a manual-trigger loop runs when its tool is called via the getLoopTools merge", () => {
  test("the loop's tool surfaces in getLoopTools and a call returns the runId + persists a run", async () => {
    defineLoop({
      id: "on-demand",
      trigger: { kind: "manual", tool: "run_now" },
      contract: { ...CAPTURE, scope: "global" },
      act: async (ctx) => ({
        kind: "terminal",
        status: "done",
        outcome: { tag: (ctx.input as { tag?: string }).tag ?? "none" },
      }),
    });

    // The author would spread this into createToolDispatcher({ ...getLoopTools(), … }).
    expect(Object.keys(getLoopTools())).toContain("run_now");

    const res = await callManualTool("run_now", { tag: "alpha" });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.text);
    expect(out).toMatchObject({ loop: "on-demand", status: "done" });

    const runs = await _getRegisteredLoop("on-demand")!.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toEqual({ tag: "alpha" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Idempotency: a re-fire with the same idempotency key while the
// first run is still OPEN is a no-op (the catch-up + double-delivery case),
// so a loop never double-dispatches.
// ════════════════════════════════════════════════════════════════════════

describe("an idempotent re-fire while a run is still open does not create a duplicate", () => {
  test("two events with the same idempotency key collapse onto ONE open run (act not re-committed)", async () => {
    let dispatches = 0;
    _setSpawnForTests(async () => {
      dispatches += 1;
      return {
        subConversationId: `sub-${dispatches}`,
        agentRunId: `run-${dispatches}`,
        taskId: `task-${dispatches}`,
        assignmentId: `assign-${dispatches}`,
      };
    });

    defineLoop({
      id: "once-per-convo",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        ...DISPATCH,
        scope: "global",
        idempotencyKey: (input) => (input as { cid?: string }).cid,
      },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "t" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
    });

    await emitEvent("run:complete", { cid: "C" });
    await emitEvent("run:complete", { cid: "C" }); // catch-up / double-deliver

    // Exactly ONE run survives — the duplicate claim collapsed onto the open
    // run rather than opening a second.
    const runs = await _getRegisteredLoop("once-per-convo")!.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.externalRunId).toBe("run-1");
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Privacy: a user-scoped run is invisible to a global dashboard.
// This is the ez-code two-loop topology (private user dispatch + shared cron)
// and the feature's most consequential guarantee — one user's runs must never
// reach the cross-user-cached Hub tree.
// ════════════════════════════════════════════════════════════════════════

describe("a user-scoped run never appears in a global dashboard render", () => {
  test("a user loop's run is persisted privately and the global dashboard renders zero runs", async () => {
    let n = 0;
    _setSpawnForTests(async () => {
      n += 1;
      return {
        subConversationId: `sub-${n}`,
        agentRunId: `run-${n}`,
        taskId: `task-${n}`,
        assignmentId: `assign-${n}`,
      };
    });

    // USER loop — private dispatch runs, NO dashboard.
    defineLoop({
      id: "user-runs",
      trigger: { kind: "manual", tool: "dispatch_mine" },
      contract: { ...DISPATCH, scope: "user" },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "mine" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
    });

    // GLOBAL loop — shared cron runs, WITH the dashboard whose render exposes
    // every run it is handed (so a leak WOULD be visible here).
    defineLoop({
      id: "shared-runs",
      trigger: { kind: "cron", cron: "0 * * * *" },
      contract: { ...DISPATCH, scope: "global" },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "shared" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
      log: {
        dashboard: {
          pageId: "dashboard",
          render: (runs) => ({
            title: "shared",
            nodes: [{ type: "runs", ids: runs.map((r) => r.id) }],
          }),
        },
      },
    });

    // Fire the PRIVATE user loop.
    await callManualTool("dispatch_mine");

    // The shared dashboard render must show NOTHING — the user run lives in a
    // separate scoped store the global render never reads.
    const dash = pagesDefined.find((d) => d.id === "dashboard")!;
    const tree = (await dash.render()) as { nodes: Array<{ ids: string[] }> };
    expect(tree.nodes[0]!.ids).toEqual([]);

    // …but privacy is not data loss: the user run DID persist.
    const userRuns = await _getRegisteredLoop("user-runs")!.store.list();
    expect(userRuns.map((r) => r.id)).toEqual(["run-1"]);

    // And completing the PRIVATE run does not push the shared page (its owning
    // loop has no dashboard).
    const pushesBefore = pagePushes.length;
    await dispatchAssignmentUpdate(
      completionEvent("task-1", "assign-1", "run-1"),
    );
    expect(pagePushes.length).toBe(pushesBefore);
    expect((await _getRegisteredLoop("user-runs")!.store.list())[0]!.status).toBe(
      "completed",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — Registration guards: the two install-time footguns crash
// LOUDLY rather than shipping a silent leak / silent clobber.
// ════════════════════════════════════════════════════════════════════════

describe("registration guards crash loudly instead of shipping a silent footgun", () => {
  test("pairing a dashboard with a non-global scope throws at registration (privacy guard)", () => {
    expect(() =>
      defineLoop({
        id: "leaky",
        trigger: { kind: "event", event: "run:complete" },
        contract: { ...CAPTURE, scope: "user" },
        act: async () => ({ kind: "terminal", status: "done", outcome: null }),
        log: {
          dashboard: { pageId: "p", render: () => ({ title: "x", nodes: [] }) },
        },
      }),
    ).toThrow(/log\.dashboard requires contract\.scope "global"/);
  });

  test("two manual loops claiming the same tool name throw at registration (clobber guard)", () => {
    defineLoop({
      id: "first",
      trigger: { kind: "manual", tool: "shared_tool" },
      contract: { ...CAPTURE, scope: "global" },
      act: async () => ({ kind: "skip", reason: "x" }),
    });
    expect(() =>
      defineLoop({
        id: "second",
        trigger: { kind: "manual", tool: "shared_tool" },
        contract: { ...CAPTURE, scope: "global" },
        act: async () => ({ kind: "skip", reason: "y" }),
      }),
    ).toThrow(/manual tool "shared_tool" is already registered/);
  });

  test("registering the same loop id twice throws (no silent re-register)", () => {
    defineLoop({
      id: "solo",
      trigger: { kind: "event", event: "run:complete" },
      contract: { ...CAPTURE, scope: "global" },
      act: async () => ({ kind: "skip", reason: "x" }),
    });
    expect(() =>
      defineLoop({
        id: "solo",
        trigger: { kind: "event", event: "tool:complete" },
        contract: { ...CAPTURE, scope: "global" },
        act: async () => ({ kind: "skip", reason: "x" }),
      }),
    ).toThrow(/duplicate loop id/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — Concurrency / TOCTOU: an event-only update (no status) that
// interleaves with a concurrent status flip must NOT revert the flip. The
// store resolves the kept status UNDER the lock, so the flip survives.
// ════════════════════════════════════════════════════════════════════════

describe("an event-only update does not revert a concurrent status flip (TOCTOU)", () => {
  test("a status flip racing an event-only note lands at the flipped status, with both events recorded", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "sub-1",
      agentRunId: "run-1",
      taskId: "task-1",
      assignmentId: "assign-1",
    }));

    defineLoop({
      id: "racy",
      trigger: { kind: "event", event: "tool:complete" },
      contract: { ...DISPATCH, scope: "global" },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "t" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
    });
    await emitEvent("tool:complete", {});
    const store = _getRegisteredLoop("racy")!.store;

    // Interleave: a real status flip (→ completed) and an event-only "steered"
    // note (no status). withLock serializes them; because the event-only
    // update resolves its kept status under the lock, the flip is never
    // reverted regardless of order.
    await Promise.all([
      store.transition("run-1", { status: "completed", note: "host says done" }),
      store.transition("run-1", { eventStatus: "steered", note: "user nudged" }),
    ]);

    const run = await store.get("run-1");
    expect(run?.status).toBe("completed"); // the flip survives
    const statuses = run!.events.map((e) => e.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("steered");
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 9 — Failure policy: consecutive PERMANENT errors auto-disable the
// loop at exactly the threshold (firing onAutoDisable once), and a disabled
// loop then skips every fire until re-enabled.
// ════════════════════════════════════════════════════════════════════════

describe("repeated permanent failures auto-disable the loop and subsequent fires are skipped", () => {
  test("the loop disables at exactly N permanent errors, notifies once, then skips further fires", async () => {
    const disabledAt: number[] = [];
    defineLoop({
      id: "flaky",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        ...CAPTURE,
        scope: "global",
        failure: {
          classify: () => "permanent",
          autoDisableAfter: 2,
          onAutoDisable: async (ctx) => {
            disabledAt.push(ctx.consecutiveErrors);
          },
        },
      },
      act: async () => {
        throw new Error("permanent boom");
      },
    });
    const store = _getRegisteredLoop("flaky")!.store;

    await emitEvent("run:complete", {}); // error 1
    expect((await store.getMeta()).disabled).toBe(false);
    await emitEvent("run:complete", {}); // error 2 → disable + notify
    expect((await store.getMeta()).disabled).toBe(true);
    expect(disabledAt).toEqual([2]);

    // A third fire is short-circuited by the disabled latch — no run, and the
    // error counter does not advance past the disable threshold.
    await emitEvent("run:complete", {});
    expect((await store.getMeta()).consecutiveErrors).toBe(2);
    expect(await store.list()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 10 — Retention: an extension that fires far past its retention cap
// keeps only the newest N TERMINAL runs (oldest evicted), so the run store
// never grows unbounded.
// ════════════════════════════════════════════════════════════════════════

describe("retention caps the persisted run history to the configured maximum", () => {
  test("firing past maxRuns evicts the oldest terminal runs, keeping the newest N", async () => {
    defineLoop({
      id: "bounded",
      trigger: { kind: "manual", tool: "tick" },
      contract: {
        ...CAPTURE,
        scope: "global",
        retention: { maxRuns: 3 },
        // Each fire is a distinct run (unique id keeps them from collapsing).
        idempotencyKey: (input) => (input as { n?: number }).n?.toString(),
      },
      act: async (ctx) => ({
        kind: "terminal",
        status: "done",
        outcome: { n: (ctx.input as { n?: number }).n },
      }),
    });

    for (let i = 1; i <= 5; i++) await callManualTool("tick", { n: i });

    const runs = await _getRegisteredLoop("bounded")!.store.list();
    // Only the newest 3 survive (each fire was terminal, so eligible to evict).
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => (r.outcome as { n: number }).n)).toEqual([5, 4, 3]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SCENARIO 11 — Multi-loop extension: one extension declares N loops (the
// memory-extractor shape — an event capture loop + a cron loop) and an inbound
// completion routes to whichever loop owns the matching open run.
// ════════════════════════════════════════════════════════════════════════

describe("an extension with multiple loops routes each trigger and completion to the right loop", () => {
  test("a capture loop and a deferred loop coexist; an assignment update lands on the deferred owner only", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "sub-1",
      agentRunId: "run-1",
      taskId: "task-1",
      assignmentId: "assign-1",
    }));

    // Loop A — terminal capture on run:complete.
    defineLoop({
      id: "capture-loop",
      trigger: { kind: "event", event: "run:complete" },
      contract: { ...CAPTURE, scope: "global" },
      act: async () => ({ kind: "terminal", status: "done", outcome: { ok: 1 } }),
    });
    // Loop B — deferred dispatch on tool:complete.
    defineLoop({
      id: "deferred-loop",
      trigger: { kind: "event", event: "tool:complete" },
      contract: { ...DISPATCH, scope: "global" },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "t" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
    });

    await emitEvent("run:complete", {}); // → capture-loop
    await emitEvent("tool:complete", {}); // → deferred-loop (opens run)

    // The completion routes ONLY to the deferred loop's open run.
    await dispatchAssignmentUpdate(
      completionEvent("task-1", "assign-1", "run-1"),
    );

    const captureRuns = await _getRegisteredLoop("capture-loop")!.store.list();
    const deferredRuns = await _getRegisteredLoop("deferred-loop")!.store.list();
    expect(captureRuns[0]!.status).toBe("done"); // untouched by the update
    expect(deferredRuns[0]!.status).toBe("completed"); // closed by the update
  });
});
