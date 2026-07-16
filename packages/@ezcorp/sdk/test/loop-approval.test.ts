// loop-approval.test.ts — Phase 2 approval lifecycle through the defineLoop
// facade. Drives the fire state machine WITHOUT a live channel (in-memory
// run store + injected seams), and injects a recording LoopEvents to assert
// the content-free approval nudges.
//
// Covers: park→approve→finalize, park→decline→discard, finalize
// crash-recovery (no double-act), closure-lost after "restart", staleness
// auto-decline, deferred→proposal composition (onComplete), label capture
// (the LOCKED eval signal) + agent-unreadability, and the resolution
// guard rails.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import {
  defineLoop,
  dispatchAssignmentUpdate,
  approveRun,
  declineRun,
  sweepStaleProposals,
  sweepAllStaleProposals,
  getLoopTools,
  _getRegisteredLoop,
  __resetLoopsForTests,
  _setSettingsResolverForTests,
  _setStoreFactoryForTests,
  _setLoopEventsForTests,
  _setProposalClosuresForTests,
} from "../src/runtime/loop";
import { AWAITING_APPROVAL, FINALIZING } from "../src/runtime/loop-core";
import { createLoopRunStore } from "../src/runtime/loop-store";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";
import type { LoopEvents } from "../src/runtime/loop-events";
import type { StorageScope } from "../src/runtime/storage";
import type { TaskAssignmentUpdateEvent } from "../src/runtime/host-event-types";
import type { ActResult, LoopProposal } from "../src/runtime/loop-types";

// ── In-memory KV + store factory ────────────────────────────────────

function makeKv() {
  const map = new Map<string, unknown>();
  return (_scope: StorageScope) => ({
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
}

// ── Recording LoopEvents ────────────────────────────────────────────

interface EmitCall {
  type: "pending" | "resolved" | "auto_disabled";
  loopId: string;
  runId?: string;
  decision?: "approved" | "declined";
  consecutiveErrors?: number;
  conversationId?: string;
}

function recordingEvents(opts: { throwOn?: "pending" | "resolved" } = {}): {
  events: LoopEvents;
  calls: EmitCall[];
} {
  const calls: EmitCall[] = [];
  const events = {
    async emitApprovalPending(p: { loopId: string; runId: string; conversationId?: string }) {
      if (opts.throwOn === "pending") throw new Error("emit boom");
      calls.push({ type: "pending", ...p });
    },
    async emitApprovalResolved(p: {
      loopId: string;
      runId: string;
      decision: "approved" | "declined";
      conversationId?: string;
    }) {
      if (opts.throwOn === "resolved") throw new Error("emit boom");
      calls.push({ type: "resolved", ...p });
    },
    async emitAutoDisabled(p: { loopId: string; consecutiveErrors: number; conversationId?: string }) {
      calls.push({ type: "auto_disabled", ...p });
    },
  } as unknown as LoopEvents;
  return { events, calls };
}

// ── Trigger capture ─────────────────────────────────────────────────

let captured: Map<string, (p: unknown) => Promise<unknown> | unknown>;

beforeEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
  captured = new Map();
  const ch: HostChannel = getChannel();
  spyOn(ch, "onRequest").mockImplementation(((
    method: string,
    handler: (p: unknown) => unknown,
  ) => {
    captured.set(method, handler);
  }) as HostChannel["onRequest"]);
  _setSettingsResolverForTests(async () => ({}));
  _setStoreFactoryForTests((<O,>(loopId: string, contract: unknown) =>
    createLoopRunStore<O>(loopId, contract as never, makeKv())) as never);
});

afterEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
  _setSettingsResolverForTests(null);
  _setStoreFactoryForTests(null);
  _setLoopEventsForTests(null);
});

async function fireEvent(event: string, payload: unknown): Promise<void> {
  const handler = captured.get(`ezcorp/event/${event}`);
  if (!handler) throw new Error(`no handler captured for event ${event}`);
  await handler(payload);
}

const PROPOSAL: LoopProposal = { title: "Draft PR", summary: "update docs", kind: "pr", ref: "pr/1" };

/** Define a proactive-approval loop whose event-triggered act returns a
 *  proposal. `finalize`/`discard` record their invocations. */
function defineApprovalLoop(opts: {
  id?: string;
  finalize?: () => Promise<unknown>;
  discard?: () => Promise<void>;
  staleAfterDays?: number;
  configVersion?: string;
  artifact?: boolean;
} = {}) {
  const finalizeCalls: number[] = [];
  const discardCalls: number[] = [];
  const artifacts: unknown[] = [];
  const id = opts.id ?? "docs";
  defineLoop({
    id,
    trigger: { kind: "event", event: "run:complete" },
    contract: {
      states: ["reviewed"],
      terminal: ["reviewed"],
      approval: { mode: "proactive", ...(opts.staleAfterDays !== undefined ? { staleAfterDays: opts.staleAfterDays } : {}) },
      ...(opts.configVersion ? { configVersion: opts.configVersion } : {}),
    },
    act: async (): Promise<ActResult> => ({
      kind: "proposal",
      status: "pr_drafted",
      proposal: PROPOSAL,
      finalize: async () => {
        finalizeCalls.push(Date.now());
        return opts.finalize ? await opts.finalize() : { merged: true };
      },
      discard: async () => {
        discardCalls.push(Date.now());
        if (opts.discard) await opts.discard();
      },
    }),
    ...(opts.artifact
      ? {
          log: {
            artifact: (_run: unknown, outcome: unknown) => {
              artifacts.push(outcome);
              return { path: "out.md", body: JSON.stringify(outcome) };
            },
          },
        }
      : {}),
  });
  return { id, finalizeCalls, discardCalls, artifacts };
}

// ── park (proposal → awaiting_approval) ─────────────────────────────

describe("park — proposal ActResult", () => {
  test("act proposal → run parks at awaiting_approval + emits pending nudge", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    defineApprovalLoop();
    await fireEvent("run:complete", { conversationId: "c1" });

    const reg = _getRegisteredLoop("docs")!;
    const runs = await reg.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe(AWAITING_APPROVAL);
    expect(runs[0]!.proposal).toEqual(PROPOSAL);
    expect(calls).toEqual([{ type: "pending", loopId: "docs", runId: runs[0]!.id }]);
  });

  test("a pending-emit failure never leaves the run unparked (best-effort)", async () => {
    const { events } = recordingEvents({ throwOn: "pending" });
    _setLoopEventsForTests(events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    expect((await reg.store.list())[0]!.status).toBe(AWAITING_APPROVAL);
  });
});

// ── park → approve → finalize ───────────────────────────────────────

describe("approve → finalize (exactly once)", () => {
  test("approve finalizes, terminalizes at approved, appends the label + resolved nudge", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    const loop = defineApprovalLoop({ artifact: true, configVersion: "v7" });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;

    const res = await approveRun("docs", runId, "alice");
    expect(res).toEqual({ ok: true, runId, decision: "approved", finalized: true });
    expect(loop.finalizeCalls).toHaveLength(1);

    const run = await reg.store.get(runId);
    expect(run?.status).toBe("approved");
    expect(run?.outcome).toEqual({ merged: true });

    // The LOCKED label captured the human decision.
    const labels = await reg.store.listLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      loopId: "docs",
      runId,
      decision: "approved",
      decidedBy: "alice",
      proposalSnapshot: PROPOSAL,
      loopConfigVersion: "v7",
    });
    // The artifact mirror ran after the terminal outcome.
    expect(loop.artifacts).toEqual([{ merged: true }]);
    // resolved nudge emitted (pending + resolved).
    expect(calls.map((c) => c.type)).toEqual(["pending", "resolved"]);
    expect(calls[1]).toMatchObject({ type: "resolved", decision: "approved" });
  });

  test("a second approve after resolution is an idempotent no-op (no double finalize)", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    const loop = defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;

    await approveRun("docs", runId, "alice");
    const again = await approveRun("docs", runId, "bob");
    expect(again).toEqual({ ok: false, reason: "already_resolved" });
    expect(loop.finalizeCalls).toHaveLength(1); // finalize ran ONCE
  });
});

// ── finalize crash / lost closure (exactly-once fail-safe) ──────────

describe("finalize exactly-once fail-safe", () => {
  test("a finalize that throws leaves the run in finalizing + verifyManually", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    const loop = defineApprovalLoop({
      finalize: async () => {
        throw new Error("merge conflict");
      },
    });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;

    const res = await approveRun("docs", runId, "alice");
    expect(res).toMatchObject({ ok: true, decision: "approved", finalized: false, verifyManually: true });
    const run = await reg.store.get(runId);
    expect(run?.status).toBe(FINALIZING);
    expect(run?.verifyManually).toBe(true);
    // Label WAS captured — the human decision is independent of finalize success.
    expect((await reg.store.listLabels())[0]?.decision).toBe("approved");
    expect(loop.finalizeCalls).toHaveLength(1);
  });

  test("approving a run in finalizing is refused (never re-invokes finalize)", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    // Force the run into finalizing (simulating a crash mid-finalize).
    await reg.store.transitionIf(runId, AWAITING_APPROVAL, { status: FINALIZING });
    expect(await approveRun("docs", runId, "alice")).toEqual({ ok: false, reason: "finalizing" });
  });

  test("approve after a restart (closure lost) flags verify-manually, never finalizes", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    // Simulate a process restart: the in-memory closure is gone.
    _setProposalClosuresForTests("docs", runId, null);

    const res = await approveRun("docs", runId, "alice");
    expect(res).toEqual({ ok: false, reason: "closures_lost" });
    const run = await reg.store.get(runId);
    expect(run?.status).toBe(AWAITING_APPROVAL); // still parked, not stranded
    expect(run?.verifyManually).toBe(true);
  });
});

// ── park → decline → discard ────────────────────────────────────────

describe("decline → discard", () => {
  test("decline terminalizes at declined, appends label, runs discard, emits resolved", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    const loop = defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;

    const res = await declineRun("docs", runId, "alice", "not needed");
    expect(res).toEqual({ ok: true, runId, decision: "declined" });
    expect(loop.discardCalls).toHaveLength(1);
    const run = await reg.store.get(runId);
    expect(run?.status).toBe("declined");
    const label = (await reg.store.listLabels())[0];
    expect(label).toMatchObject({ decision: "declined", decidedBy: "alice", note: "not needed" });
    expect(calls[1]).toMatchObject({ type: "resolved", decision: "declined" });
  });

  test("a discard that throws still leaves the run declined (best-effort cleanup)", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop({
      discard: async () => {
        throw new Error("cleanup failed");
      },
    });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    expect((await declineRun("docs", runId, "alice")).ok).toBe(true);
    expect((await reg.store.get(runId))?.status).toBe("declined");
  });

  test("decline with no discard closure is a clean terminal", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    _setProposalClosuresForTests("docs", runId, null); // no discard available
    expect((await declineRun("docs", runId, "alice")).ok).toBe(true);
    expect((await reg.store.get(runId))?.status).toBe("declined");
  });
});

// ── resolution guard rails ──────────────────────────────────────────

describe("resolution guard rails", () => {
  test("unknown loop / unknown run", async () => {
    expect(await approveRun("nope", "r1", "u")).toEqual({ ok: false, reason: "unknown_loop" });
    expect(await declineRun("nope", "r1", "u")).toEqual({ ok: false, reason: "unknown_loop" });
    defineApprovalLoop();
    expect(await approveRun("docs", "ghost", "u")).toEqual({ ok: false, reason: "unknown_run" });
    expect(await declineRun("docs", "ghost", "u")).toEqual({ ok: false, reason: "unknown_run" });
  });

  test("approve/decline refuse a non-parked run", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineLoop({
      id: "cap",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["running", "done"], terminal: ["done"], approval: {} },
      act: async () => ({ kind: "terminal", status: "running", outcome: 1 }),
    });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("cap")!;
    const runId = (await reg.store.list())[0]!.id; // status "running", not parked
    expect(await approveRun("cap", runId, "u")).toEqual({ ok: false, reason: "not_parked" });
    expect(await declineRun("cap", runId, "u")).toEqual({ ok: false, reason: "not_parked" });
  });

  test("a parked run with no proposal snapshot is refused", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    const reg = _getRegisteredLoop("docs")!;
    // Claim a run directly at awaiting_approval WITHOUT a proposal.
    await reg.store.claim({ id: "bare", loopId: "docs", status: AWAITING_APPROVAL });
    expect(await approveRun("docs", "bare", "u")).toEqual({ ok: false, reason: "no_proposal" });
    expect(await declineRun("docs", "bare", "u")).toEqual({ ok: false, reason: "no_proposal" });
  });

  test("already-declined run refuses a subsequent approve", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    await declineRun("docs", runId, "alice");
    expect(await approveRun("docs", runId, "bob")).toEqual({ ok: false, reason: "already_resolved" });
    expect(await declineRun("docs", runId, "bob")).toEqual({ ok: false, reason: "already_resolved" });
  });
});

// ── staleness auto-decline ──────────────────────────────────────────

describe("staleness auto-decline", () => {
  test("a parked proposal past the horizon auto-declines with a system label", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    const loop = defineApprovalLoop({ staleAfterDays: 3 });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    const created = Date.parse((await reg.store.get(runId))!.createdAt);

    const n = await sweepStaleProposals("docs", created + 4 * 24 * 60 * 60 * 1000);
    expect(n).toBe(1);
    const run = await reg.store.get(runId);
    expect(run?.status).toBe("declined");
    expect(loop.discardCalls).toHaveLength(1);
    const label = (await reg.store.listLabels())[0];
    expect(label).toMatchObject({ decision: "declined", decidedBy: "system" });
    expect(label?.note).toMatch(/staleness horizon/);
  });

  test("sweep is a no-op for an unknown loop, a non-approval loop, or staleAfterDays 0", async () => {
    expect(await sweepStaleProposals("nope")).toBe(0);
    defineLoop({
      id: "plain",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: 1 }),
    });
    expect(await sweepStaleProposals("plain")).toBe(0);
    defineApprovalLoop({ id: "never", staleAfterDays: 0 });
    expect(await sweepStaleProposals("never")).toBe(0);
  });

  test("every fire opportunistically runs the staleness sweep (best-effort)", async () => {
    // The sweep runs at the top of each approval-loop fire; a fresh proposal
    // is never stale, so the fire still parks. This exercises the
    // opportunistic-sweep branch in runFire without a clock injection.
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop({ staleAfterDays: 3 });
    await fireEvent("run:complete", {});
    await fireEvent("run:complete", {}); // second fire → sweep runs again, no throw
    const reg = _getRegisteredLoop("docs")!;
    // Both fires parked (idempotency off here → two parked runs), neither reaped.
    const parked = (await reg.store.list()).filter((r) => r.status === AWAITING_APPROVAL);
    expect(parked.length).toBeGreaterThanOrEqual(1);
  });
});

// ── deferred → proposal composition (onComplete) ────────────────────

describe("deferred → proposal composition", () => {
  function defineDeferred(onComplete: (ctx: {
    run: unknown;
    status: string;
    resultPreview?: string;
  }) => Promise<ActResult>, id = "dd") {
    defineLoop({
      id,
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "completed", "failed"],
        terminal: ["completed", "failed"],
        approval: {},
      },
      act: async (): Promise<ActResult> => ({
        kind: "deferred",
        runId: "agent-1",
        status: "dispatched",
        awaitEvent: "task:assignment_update",
      }),
      onComplete,
    });
  }

  const completeEvt: TaskAssignmentUpdateEvent = {
    conversationId: "c1",
    taskId: "t1",
    assignment: {
      id: "a1",
      agentConfigId: "cfg",
      agentName: "coder",
      isTeam: false,
      status: "completed",
      assignedAt: "2026-07-16T00:00:00Z",
      agentRunId: "agent-1",
      resultPreview: "done drafting",
    },
  };

  test("onComplete → proposal parks the completed deferred run for approval", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    let finalized = 0;
    defineDeferred(async (ctx) => {
      expect(ctx.status).toBe("completed");
      expect(ctx.resultPreview).toBe("done drafting");
      return {
        kind: "proposal",
        status: "pr_ready",
        proposal: PROPOSAL,
        finalize: async () => {
          finalized++;
          return { ok: true };
        },
      };
    });
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt);

    const reg = _getRegisteredLoop("dd")!;
    const run = (await reg.store.list())[0]!;
    expect(run.status).toBe(AWAITING_APPROVAL);
    expect(run.proposal).toEqual(PROPOSAL);
    expect(calls.some((c) => c.type === "pending")).toBe(true);

    // The parked deferred run approves + finalizes like any other.
    expect((await approveRun("dd", run.id, "alice")).ok).toBe(true);
    expect(finalized).toBe(1);
  });

  test("onComplete → terminal terminalizes with the outcome", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineDeferred(async () => ({ kind: "terminal", status: "completed", outcome: { n: 5 } }));
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt);
    const reg = _getRegisteredLoop("dd")!;
    const run = (await reg.store.list())[0]!;
    expect(run.status).toBe("completed");
    expect(run.outcome).toEqual({ n: 5 });
  });

  test("onComplete opting out (skip) falls back to the default terminalize", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineDeferred(async () => ({ kind: "skip", reason: "nothing to propose" }));
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt);
    const reg = _getRegisteredLoop("dd")!;
    expect((await reg.store.list())[0]!.status).toBe("completed");
  });

  test("onComplete that throws falls back to the default terminalize", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineDeferred(async () => {
      throw new Error("onComplete boom");
    });
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt);
    const reg = _getRegisteredLoop("dd")!;
    expect((await reg.store.list())[0]!.status).toBe("completed");
  });

  test("onComplete returning an invalid proposal falls back to terminalize", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineDeferred(async () => ({
      kind: "proposal",
      status: "x",
      proposal: { title: "", summary: "s", kind: "pr" },
      finalize: async () => ({}),
    }));
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt);
    const reg = _getRegisteredLoop("dd")!;
    expect((await reg.store.list())[0]!.status).toBe("completed");
  });
});

// ── auto-disable notification ───────────────────────────────────────

describe("auto-disable emits a user-visible notice", () => {
  test("tripping autoDisableAfter emits loops:auto_disabled (never a silent stop)", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    const onDisable: number[] = [];
    defineLoop({
      id: "flaky",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: {
          classify: () => "permanent",
          autoDisableAfter: 2,
          onAutoDisable: (ctx) => { onDisable.push(ctx.consecutiveErrors); },
        },
      },
      act: async () => {
        throw new Error("always fails");
      },
    });
    await fireEvent("run:complete", {}); // error 1
    await fireEvent("run:complete", {}); // error 2 → trips auto-disable
    const notice = calls.find((c) => c.type === "auto_disabled");
    expect(notice).toMatchObject({ type: "auto_disabled", loopId: "flaky", consecutiveErrors: 2 });
    // The author's onAutoDisable hook still ran too.
    expect(onDisable).toEqual([2]);
  });
});

// ── manual-tool proposal + agent-unreadability ──────────────────────

describe("manual trigger + label isolation", () => {
  test("the label store is not surfaced by any run/skip accessor an agent can read", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    await approveRun("docs", runId, "alice");
    // Labels live in their OWN key; the run record + skip journal (the only
    // things a dashboard render / tool exposes) never carry the label array.
    const run = await reg.store.get(runId);
    expect(run).not.toHaveProperty("labels");
    expect(await reg.store.listSkips()).toEqual([]);
    expect(await reg.store.listLabels()).toHaveLength(1);
  });
});

// ── dispatchAssignmentUpdate — parked / closed guard (idempotency) ───

describe("dispatchAssignmentUpdate — parked / closed guard", () => {
  const completeEvt: TaskAssignmentUpdateEvent = {
    conversationId: "c1",
    taskId: "t1",
    assignment: {
      id: "a1",
      agentConfigId: "cfg",
      agentName: "coder",
      isTeam: false,
      status: "completed",
      assignedAt: "2026-07-16T00:00:00Z",
      agentRunId: "agent-1",
      resultPreview: "done",
    },
  };

  function defineDeferredApproval(
    onComplete: (ctx: { run: unknown; status: string; resultPreview?: string }) => Promise<ActResult>,
    id = "dg",
  ) {
    defineLoop({
      id,
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "completed", "failed"],
        terminal: ["completed", "failed"],
        approval: {},
      },
      act: async (): Promise<ActResult> => ({
        kind: "deferred",
        runId: "agent-1",
        status: "dispatched",
        awaitEvent: "task:assignment_update",
      }),
      onComplete,
    });
  }

  test("a DUPLICATE terminal assignment_update while parked is a no-op (onComplete not re-run, no duplicate nudge)", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    let onCompleteCalls = 0;
    defineDeferredApproval(async () => {
      onCompleteCalls++;
      return { kind: "proposal", status: "pr", proposal: PROPOSAL, finalize: async () => ({ ok: true }) };
    });
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt); // parks
    await dispatchAssignmentUpdate(completeEvt); // duplicate while parked

    const reg = _getRegisteredLoop("dg")!;
    const runs = await reg.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe(AWAITING_APPROVAL);
    expect(onCompleteCalls).toBe(1); // NOT re-run
    expect(calls.filter((c) => c.type === "pending")).toHaveLength(1); // no duplicate nudge
  });

  test("a LATE assignment_update during finalizing is a no-op (never flipped to terminal without a decision)", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineDeferredApproval(async () => ({
      kind: "proposal",
      status: "pr",
      proposal: PROPOSAL,
      finalize: async () => ({ ok: true }),
    }));
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt); // parks (awaiting_approval)
    const reg = _getRegisteredLoop("dg")!;
    const runId = (await reg.store.list())[0]!.id;
    // Simulate an in-flight approve: move the run to `finalizing`.
    await reg.store.transitionIf(runId, AWAITING_APPROVAL, { status: FINALIZING, eventStatus: FINALIZING });

    await dispatchAssignmentUpdate(completeEvt); // LATE event during finalizing
    expect((await reg.store.get(runId))!.status).toBe(FINALIZING); // unchanged
  });

  test("a duplicate assignment_update for an already-terminal run appends nothing", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    // A deferred loop WITHOUT approval → default terminalize on completion.
    defineLoop({
      id: "dt",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["dispatched", "completed", "failed"], terminal: ["completed", "failed"] },
      act: async (): Promise<ActResult> => ({
        kind: "deferred",
        runId: "agent-1",
        status: "dispatched",
        awaitEvent: "task:assignment_update",
      }),
    });
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate(completeEvt); // terminalizes → completed
    const reg = _getRegisteredLoop("dt")!;
    const first = (await reg.store.list())[0]!;
    expect(first.status).toBe("completed");
    const eventCount = first.events.length;

    await dispatchAssignmentUpdate(completeEvt); // duplicate on the terminal run
    const second = (await reg.store.list())[0]!;
    expect(second.status).toBe("completed");
    expect(second.events.length).toBe(eventCount); // no extra event-log entry
  });

  test("a LOST CAS on the terminalize (concurrent resolver moved the run) is a clean no-op", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    // Wrap the store so the terminalize's compare-and-set always loses,
    // simulating a concurrent resolver that advanced the run between the
    // guard read and the transition.
    _setStoreFactoryForTests((<O,>(loopId: string, contract: unknown) => {
      const base = createLoopRunStore<O>(loopId, contract as never, makeKv());
      return { ...base, transitionIf: async () => null };
    }) as never);
    defineLoop({
      id: "cas",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["dispatched", "completed", "failed"], terminal: ["completed", "failed"] },
      act: async (): Promise<ActResult> => ({
        kind: "deferred",
        runId: "agent-1",
        status: "dispatched",
        awaitEvent: "task:assignment_update",
      }),
    });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("cas")!;
    expect((await reg.store.list())[0]!.status).toBe("dispatched");

    await dispatchAssignmentUpdate(completeEvt); // CAS loses → no-op
    expect((await reg.store.list())[0]!.status).toBe("dispatched"); // unchanged
  });
});

// ── re-park idempotency (duplicate fire on a parked run) ────────────

describe("runFire proposal — duplicate fire keeps the original snapshot + closures", () => {
  test("a duplicate fire (same idempotencyKey) on a parked run does not re-park or re-bind closures", async () => {
    const { events, calls } = recordingEvents();
    _setLoopEventsForTests(events);
    let fireSeq = 0;
    defineLoop({
      id: "idem",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["reviewed"],
        terminal: ["reviewed"],
        approval: { mode: "proactive" },
        idempotencyKey: () => "same-key",
      },
      act: async (): Promise<ActResult> => {
        const seq = ++fireSeq;
        return {
          kind: "proposal",
          status: "pr",
          proposal: { ...PROPOSAL, ref: `pr/${seq}` },
          finalize: async () => ({ fromFire: seq }),
        };
      },
    });
    await fireEvent("run:complete", {}); // fire 1 → parks (pr/1, closure → fromFire:1)
    await fireEvent("run:complete", {}); // fire 2 → duplicate open run → no re-park

    const reg = _getRegisteredLoop("idem")!;
    const runs = await reg.store.list();
    expect(runs).toHaveLength(1);
    // ORIGINAL snapshot retained (not overwritten by fire 2's pr/2).
    expect(runs[0]!.proposal!.ref).toBe("pr/1");
    // Exactly one pending nudge (no duplicate).
    expect(calls.filter((c) => c.type === "pending")).toHaveLength(1);
    // Approving invokes fire 1's closure, not fire 2's.
    const res = await approveRun("idem", runs[0]!.id, "alice");
    expect(res.ok).toBe(true);
    expect((await reg.store.get(runs[0]!.id))!.outcome).toEqual({ fromFire: 1 });
  });
});

// ── label-append failure — verifyManually + decline escape hatch ────

describe("approve — label-append failure never wedges the run in finalizing", () => {
  test("a failed label append flags verifyManually and lets a human decline the finalizing run", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    // A store whose FIRST appendLabel throws (a transient store blip), then
    // recovers — the approve's label write fails, the later decline's succeeds.
    let labelCalls = 0;
    _setStoreFactoryForTests((<O,>(loopId: string, contract: unknown) => {
      const base = createLoopRunStore<O>(loopId, contract as never, makeKv());
      return {
        ...base,
        appendLabel: async (entry: Parameters<typeof base.appendLabel>[0]) => {
          labelCalls++;
          if (labelCalls === 1) throw new Error("label store down (transient)");
          return base.appendLabel(entry);
        },
      };
    }) as never);

    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;

    const approve = await approveRun("docs", runId, "alice");
    expect(approve).toEqual({ ok: false, reason: "label_append_failed" });
    const stuck = await reg.store.get(runId);
    expect(stuck!.status).toBe(FINALIZING);
    expect(stuck!.verifyManually).toBe(true);

    // Escape hatch: a human can decline the flagged finalizing run (the label
    // store has recovered, so the decline's own label write succeeds).
    const decline = await declineRun("docs", runId, "alice", "manual cleanup");
    expect(decline).toEqual({ ok: true, runId, decision: "declined" });
    expect((await reg.store.get(runId))!.status).toBe("declined");
  });

  test("a finalizing run WITHOUT the verifyManually flag is NOT declinable", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop();
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("docs")!;
    const runId = (await reg.store.list())[0]!.id;
    // Move to finalizing WITHOUT the verifyManually flag (a legitimate
    // in-flight finalize).
    await reg.store.transitionIf(runId, AWAITING_APPROVAL, { status: FINALIZING, eventStatus: FINALIZING });
    expect(await declineRun("docs", runId, "bob")).toEqual({ ok: false, reason: "finalizing" });
  });
});

// ── fire-independent staleness sweep ────────────────────────────────

describe("sweepAllStaleProposals — reaps every registered loop", () => {
  test("one pass auto-declines stale parked proposals across all loops", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineApprovalLoop({ id: "sa", staleAfterDays: 7 });
    defineApprovalLoop({ id: "sb", staleAfterDays: 7 });
    const regA = _getRegisteredLoop("sa")!;
    const regB = _getRegisteredLoop("sb")!;
    await regA.store.claim({ id: "ra", loopId: "sa", status: AWAITING_APPROVAL, proposal: PROPOSAL });
    await regB.store.claim({ id: "rb", loopId: "sb", status: AWAITING_APPROVAL, proposal: PROPOSAL });

    // A clock 8 days ahead crosses the 7-day horizon for both.
    const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(await sweepAllStaleProposals(future)).toBe(2);
    expect((await regA.store.get("ra"))!.status).toBe("declined");
    expect((await regB.store.get("rb"))!.status).toBe("declined");
  });

  test("a loop without approval is skipped by the sweep", async () => {
    _setLoopEventsForTests(recordingEvents().events);
    defineLoop({
      id: "noappr",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async (): Promise<ActResult> => ({ kind: "terminal", status: "done", outcome: {} }),
    });
    // No approval → nothing to sweep, and the pass never throws.
    expect(await sweepAllStaleProposals(Date.now() + 10 * 24 * 60 * 60 * 1000)).toBe(0);
  });
});

// ── kill-switch honesty — manual tool fires stay live ───────────────

describe("kill-switch honesty — manual tool fires stay live", () => {
  test("a manual-trigger tool fire runs unconditionally (the SDK holds no host-kill-switch state)", async () => {
    // Documents the Phase-2 kill-switch limit surfaced in the admin UI + docs:
    // scheduled + event fires are host-gated, but a manual `tool` trigger runs
    // through the ordinary tool-call path — indistinguishable from any other
    // tool call at the host boundary, so there is no clean seam to gate it.
    // The SDK loop primitive holds no host-switch state, so the fire runs.
    _setLoopEventsForTests(recordingEvents().events);
    let acted = 0;
    defineLoop({
      id: "manual",
      trigger: { kind: "manual", tool: "run_manual" },
      contract: { states: ["done"] },
      act: async (): Promise<ActResult> => {
        acted++;
        return { kind: "terminal", status: "done", outcome: { ok: true } };
      },
    });
    const handler = getLoopTools()["run_manual"]!;
    await handler({}, undefined);
    expect(acted).toBe(1);
    const reg = _getRegisteredLoop("manual")!;
    expect((await reg.store.list())[0]!.status).toBe("done");
  });
});
