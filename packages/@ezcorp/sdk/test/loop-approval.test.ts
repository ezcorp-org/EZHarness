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
  type: "pending" | "resolved";
  loopId: string;
  runId: string;
  decision?: "approved" | "declined";
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
            artifact: (run: unknown, outcome: unknown) => {
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
