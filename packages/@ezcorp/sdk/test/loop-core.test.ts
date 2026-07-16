// loop-core.test.ts — 100% coverage for the pure Loop state machine.
//
// Pure module: no channel, no clock dependency (time is injected). Each
// function is a plain transform on data, so every contract branch is
// pinned here per the spec's Phase-1 test mandate:
//   - every state transition incl. deferred→running→terminal
//   - idempotency dupe = no-op
//   - retention trims oldest TERMINAL beyond maxRuns (never an open run)
//   - event log caps at maxEventsPerRun
//   - classify transient vs permanent
//   - auto-disable at EXACTLY N consecutive permanent errors
//   - skip is not an error

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_RUNS,
  DEFAULT_STATES,
  appendEvent,
  autoDisableContext,
  classifyFailure,
  createRun,
  findOpenDuplicate,
  isKnownState,
  isLive,
  isTerminal,
  resolveContract,
  transition,
  trimRetention,
  validateActResult,
  validateCheckResult,
} from "../src/runtime/loop-core";
import type {
  ActResult,
  CheckResult,
  LoopRunState,
  ResolvedContract,
} from "../src/runtime/loop-types";

const T0 = "2026-06-18T00:00:00.000Z";

// A deferred-shaped contract: dispatched→running→{completed|failed|cancelled}.
function deferredContract(): ResolvedContract {
  return resolveContract({
    states: ["dispatched", "running", "completed", "failed", "cancelled"],
    terminal: ["completed", "failed", "cancelled"],
    scope: "global",
  });
}

// ── resolveContract defaults ────────────────────────────────────────

describe("resolveContract", () => {
  test("empty contract → terminal 'done' loop with parity defaults", () => {
    const c = resolveContract();
    expect(c.states).toEqual(DEFAULT_STATES);
    expect(c.terminal).toEqual(DEFAULT_STATES);
    expect(c.scope).toBe("global");
    expect(c.maxRuns).toBe(DEFAULT_MAX_RUNS);
    expect(c.maxEventsPerRun).toBe(DEFAULT_MAX_EVENTS_PER_RUN);
    expect(c.autoDisableAfter).toBe(0);
    expect(c.classify(new Error("x"))).toBe("transient");
    expect(c.idempotencyKey).toBeUndefined();
    expect(c.onAutoDisable).toBeUndefined();
  });

  test("empty states array falls back to default", () => {
    const c = resolveContract({ states: [] });
    expect(c.states).toEqual(DEFAULT_STATES);
  });

  test("terminal defaults to all states when omitted/empty", () => {
    const c = resolveContract({ states: ["a", "b"] });
    expect(c.terminal).toEqual(["a", "b"]);
    const c2 = resolveContract({ states: ["a", "b"], terminal: [] });
    expect(c2.terminal).toEqual(["a", "b"]);
  });

  test("explicit terminal subset is honored", () => {
    const c = deferredContract();
    expect(c.terminal).toEqual(["completed", "failed", "cancelled"]);
  });

  test("retention + failure overrides are threaded through", () => {
    const onAutoDisable = async () => {};
    const idempotencyKey = (i: unknown) => String(i);
    const c = resolveContract({
      retention: { maxRuns: 5, maxEventsPerRun: 3 },
      failure: {
        classify: () => "permanent",
        autoDisableAfter: 2,
        onAutoDisable,
      },
      idempotencyKey,
    });
    expect(c.maxRuns).toBe(5);
    expect(c.maxEventsPerRun).toBe(3);
    expect(c.autoDisableAfter).toBe(2);
    expect(c.classify(new Error("x"))).toBe("permanent");
    expect(c.onAutoDisable).toBe(onAutoDisable);
    expect(c.idempotencyKey).toBe(idempotencyKey);
  });
});

// ── status predicates ───────────────────────────────────────────────

describe("status predicates", () => {
  const c = deferredContract();
  test("isTerminal", () => {
    expect(isTerminal("completed", c)).toBe(true);
    expect(isTerminal("running", c)).toBe(false);
  });
  test("isLive is the negation of isTerminal", () => {
    expect(isLive({ status: "dispatched" }, c)).toBe(true);
    expect(isLive({ status: "running" }, c)).toBe(true);
    expect(isLive({ status: "completed" }, c)).toBe(false);
  });
  test("isKnownState", () => {
    expect(isKnownState("running", c)).toBe(true);
    expect(isKnownState("bogus", c)).toBe(false);
  });
});

// ── event-log capping ───────────────────────────────────────────────

describe("appendEvent", () => {
  test("prepends newest first", () => {
    const out = appendEvent(
      [{ at: T0, status: "a" }],
      { at: T0, status: "b" },
      10,
    );
    expect(out.map((e) => e.status)).toEqual(["b", "a"]);
  });

  test("caps at maxEventsPerRun, evicting oldest", () => {
    let events: { at: string; status: string }[] = [];
    for (let i = 0; i < 60; i++) {
      events = appendEvent(events, { at: T0, status: `s${i}` }, 50);
    }
    expect(events.length).toBe(50);
    expect(events[0]!.status).toBe("s59");
    expect(events[49]!.status).toBe("s10");
  });

  test("maxEventsPerRun of 0 keeps nothing; negative is clamped to 0", () => {
    expect(appendEvent([], { at: T0, status: "a" }, 0)).toEqual([]);
    expect(appendEvent([], { at: T0, status: "a" }, -5)).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const input = [{ at: T0, status: "a" }];
    appendEvent(input, { at: T0, status: "b" }, 10);
    expect(input).toEqual([{ at: T0, status: "a" }]);
  });
});

// ── createRun ───────────────────────────────────────────────────────

describe("createRun", () => {
  const c = deferredContract();

  test("minimal terminal-loop run", () => {
    const run = createRun(
      { id: "r1", loopId: "distill", status: "dispatched" },
      c,
      T0,
    );
    expect(run).toMatchObject({
      id: "r1",
      loopId: "distill",
      scope: "global",
      status: "dispatched",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(run.events).toEqual([{ at: T0, status: "dispatched" }]);
    expect(run.idempotencyKey).toBeUndefined();
    expect(run.input).toBeUndefined();
  });

  test("threads optional fields incl. initial note + deferred ids", () => {
    const run = createRun(
      {
        id: "r2",
        loopId: "ezc",
        status: "dispatched",
        input: { task: "x" },
        idempotencyKey: "key-1",
        externalRunId: "ext-run",
        externalAssignmentId: "ext-assign",
        externalTaskId: "ext-task",
        subConversationId: "sub-1",
        note: "kicked off",
      },
      c,
      T0,
    );
    expect(run.input).toEqual({ task: "x" });
    expect(run.idempotencyKey).toBe("key-1");
    expect(run.externalRunId).toBe("ext-run");
    expect(run.externalAssignmentId).toBe("ext-assign");
    expect(run.externalTaskId).toBe("ext-task");
    expect(run.subConversationId).toBe("sub-1");
    expect(run.events).toEqual([{ at: T0, status: "dispatched", note: "kicked off" }]);
  });
});

// ── transition: the full deferred lifecycle ─────────────────────────

describe("transition", () => {
  const c = deferredContract();

  test("eventStatus records a DISTINCT event status from the run status", () => {
    // A "steered" event keeps the run at "running" but logs status "steered".
    let run: LoopRunState = createRun(
      { id: "r1", loopId: "ezc", status: "running" },
      c,
      T0,
    );
    run = transition(run, { status: "running", eventStatus: "steered", note: "focus" }, c, T0);
    expect(run.status).toBe("running"); // run status unchanged
    expect(run.events[0]).toEqual({ at: T0, status: "steered", note: "focus" });
  });

  test("eventStatus defaults to status when omitted", () => {
    let run: LoopRunState = createRun(
      { id: "r1", loopId: "ezc", status: "dispatched" },
      c,
      T0,
    );
    run = transition(run, { status: "running" }, c, T0);
    expect(run.events[0]!.status).toBe("running");
  });

  test("deferred → running → completed, carrying outcome + capped log", () => {
    const t1 = "2026-06-18T00:01:00.000Z";
    const t2 = "2026-06-18T00:02:00.000Z";
    let run: LoopRunState = createRun(
      { id: "r1", loopId: "ezc", status: "dispatched" },
      c,
      T0,
    );
    run = transition(run, { status: "running", note: "agent picked up" }, c, t1);
    expect(run.status).toBe("running");
    expect(run.updatedAt).toBe(t1);
    expect(run.events[0]).toEqual({ at: t1, status: "running", note: "agent picked up" });

    run = transition(
      run,
      { status: "completed", outcome: { url: "pr/1" } },
      c,
      t2,
    );
    expect(run.status).toBe("completed");
    expect(run.outcome).toEqual({ url: "pr/1" });
    // newest-first event order, 3 entries total
    expect(run.events.map((e) => e.status)).toEqual([
      "completed",
      "running",
      "dispatched",
    ]);
  });

  test("each terminal sink (failed, cancelled) is reachable", () => {
    let run = createRun({ id: "r", loopId: "l", status: "running" }, c, T0);
    run = transition(run, { status: "failed" }, c, T0);
    expect(isTerminal(run.status, c)).toBe(true);

    let run2 = createRun({ id: "r2", loopId: "l", status: "running" }, c, T0);
    run2 = transition(run2, { status: "cancelled" }, c, T0);
    expect(isTerminal(run2.status, c)).toBe(true);
  });

  test("threads deferred correlation ids on transition", () => {
    const run = createRun({ id: "r", loopId: "l", status: "dispatched" }, c, T0);
    const next = transition(
      run,
      {
        status: "running",
        externalRunId: "x",
        externalAssignmentId: "a",
        externalTaskId: "t",
        subConversationId: "s",
      },
      c,
      T0,
    );
    expect(next).toMatchObject({
      externalRunId: "x",
      externalAssignmentId: "a",
      externalTaskId: "t",
      subConversationId: "s",
    });
  });

  test("does not mutate the input run", () => {
    const run = createRun({ id: "r", loopId: "l", status: "dispatched" }, c, T0);
    const snapshot = JSON.parse(JSON.stringify(run));
    transition(run, { status: "running" }, c, T0);
    expect(run).toEqual(snapshot);
  });
});

// ── validateActResult ───────────────────────────────────────────────

describe("validateActResult", () => {
  const c = deferredContract();

  test("skip always passes (carries no status)", () => {
    const skip: ActResult = { kind: "skip", reason: "settings_disabled" };
    expect(validateActResult(skip, c)).toBeNull();
  });

  test("terminal with known status passes", () => {
    const r: ActResult = { kind: "terminal", status: "completed", outcome: {} };
    expect(validateActResult(r, c)).toBeNull();
  });

  test("deferred with known status passes", () => {
    const r: ActResult = {
      kind: "deferred",
      runId: "x",
      status: "dispatched",
      awaitEvent: "task:assignment_update",
    };
    expect(validateActResult(r, c)).toBeNull();
  });

  test("unknown status is rejected with a helpful message", () => {
    const r: ActResult = { kind: "terminal", status: "bogus", outcome: {} };
    const err = validateActResult(r, c);
    expect(err).toContain("bogus");
    expect(err).toContain("contract.states");
  });
});

// ── validateCheckResult ─────────────────────────────────────────────

describe("validateCheckResult", () => {
  test("proceed:true always passes (with or without enrichment)", () => {
    expect(validateCheckResult({ proceed: true })).toBeNull();
    expect(validateCheckResult({ proceed: true, input: { x: 1 } })).toBeNull();
  });

  test("proceed:false with a non-empty reason passes", () => {
    const r: CheckResult = { proceed: false, reason: "no_new_commits" };
    expect(validateCheckResult(r)).toBeNull();
  });

  test("proceed:false with an empty reason is rejected", () => {
    const r = { proceed: false, reason: "" } as CheckResult;
    const err = validateCheckResult(r);
    expect(err).toContain("reason");
  });

  test("proceed:false with a non-string reason is rejected", () => {
    const r = { proceed: false, reason: 42 as unknown as string } as CheckResult;
    expect(validateCheckResult(r)).toContain("reason");
  });
});

// ── idempotency: dupe = no-op ───────────────────────────────────────

describe("findOpenDuplicate", () => {
  const c = deferredContract();

  function runWith(
    id: string,
    status: string,
    idempotencyKey?: string,
  ): LoopRunState {
    return createRun(
      { id, loopId: "l", status, ...(idempotencyKey ? { idempotencyKey } : {}) },
      c,
      T0,
    );
  }

  test("no key → never a dupe", () => {
    const runs = [runWith("r1", "running", "k1")];
    expect(findOpenDuplicate(runs, undefined, c)).toBeUndefined();
  });

  test("matching key on an OPEN run → duplicate (no-op signal)", () => {
    const runs = [runWith("r1", "running", "k1")];
    expect(findOpenDuplicate(runs, "k1", c)?.id).toBe("r1");
  });

  test("matching key only on a TERMINAL run → NOT a dupe (may re-run)", () => {
    const runs = [runWith("r1", "completed", "k1")];
    expect(findOpenDuplicate(runs, "k1", c)).toBeUndefined();
  });

  test("prefers the open run when both terminal + open share a key", () => {
    const runs = [
      runWith("r-old", "completed", "k1"),
      runWith("r-open", "running", "k1"),
    ];
    expect(findOpenDuplicate(runs, "k1", c)?.id).toBe("r-open");
  });
});

// ── retention: trim oldest TERMINAL beyond maxRuns ──────────────────

describe("trimRetention", () => {
  function contractMax(n: number): ResolvedContract {
    return resolveContract({
      states: ["running", "done"],
      terminal: ["done"],
      retention: { maxRuns: n },
    });
  }

  function run(id: string, status: string, createdAt: string): LoopRunState {
    return {
      id,
      loopId: "l",
      scope: "global",
      status,
      events: [],
      createdAt,
      updatedAt: createdAt,
    };
  }

  test("under budget → returned unchanged (copy)", () => {
    const c = contractMax(10);
    const runs = [run("a", "done", "2026-01-01T00:00:00Z")];
    const out = trimRetention(runs, c);
    expect(out).toEqual(runs);
    expect(out).not.toBe(runs);
  });

  test("evicts the OLDEST terminal runs first, preserving order of survivors", () => {
    const c = contractMax(2);
    const runs = [
      run("new", "done", "2026-01-03T00:00:00Z"),
      run("mid", "done", "2026-01-02T00:00:00Z"),
      run("old", "done", "2026-01-01T00:00:00Z"),
    ];
    const out = trimRetention(runs, c);
    expect(out.map((r) => r.id)).toEqual(["new", "mid"]);
  });

  test("never evicts an OPEN run, even when it is the oldest", () => {
    const c = contractMax(1);
    const runs = [
      run("done-new", "done", "2026-01-03T00:00:00Z"),
      run("open-old", "running", "2026-01-01T00:00:00Z"),
    ];
    const out = trimRetention(runs, c);
    // Over budget by 1; only the terminal run is an eviction candidate.
    expect(out.map((r) => r.id)).toEqual(["open-old"]);
  });

  test("keeps ALL open runs when they exceed maxRuns (never drop live state)", () => {
    const c = contractMax(1);
    const runs = [
      run("o1", "running", "2026-01-01T00:00:00Z"),
      run("o2", "running", "2026-01-02T00:00:00Z"),
      run("o3", "running", "2026-01-03T00:00:00Z"),
    ];
    const out = trimRetention(runs, c);
    expect(out.map((r) => r.id)).toEqual(["o1", "o2", "o3"]);
  });
});

// ── failure classification + auto-disable at EXACTLY N ──────────────

describe("classifyFailure", () => {
  test("transient resets the consecutive count and never disables", () => {
    const c = resolveContract({
      failure: { classify: () => "transient", autoDisableAfter: 3 },
    });
    const d = classifyFailure(new Error("503"), 2, c);
    expect(d).toEqual({ class: "transient", consecutiveErrors: 0, shouldDisable: false });
  });

  test("permanent increments and disables at EXACTLY the threshold", () => {
    const c = resolveContract({
      failure: { classify: () => "permanent", autoDisableAfter: 3 },
    });
    // prior 0 → 1 (no), 1 → 2 (no), 2 → 3 (YES, exactly N)
    expect(classifyFailure({}, 0, c).shouldDisable).toBe(false);
    expect(classifyFailure({}, 1, c).shouldDisable).toBe(false);
    const trip = classifyFailure({}, 2, c);
    expect(trip).toEqual({ class: "permanent", consecutiveErrors: 3, shouldDisable: true });
  });

  test("autoDisableAfter of 0 never disables (even on many permanent errors)", () => {
    const c = resolveContract({
      failure: { classify: () => "permanent", autoDisableAfter: 0 },
    });
    expect(classifyFailure({}, 99, c).shouldDisable).toBe(false);
  });

  test("default classify treats everything as transient", () => {
    const c = resolveContract();
    expect(classifyFailure(new Error("x"), 5, c).class).toBe("transient");
  });

  test("autoDisableContext snapshots the loop, count, and last error", () => {
    const c = resolveContract({
      failure: { classify: () => "permanent", autoDisableAfter: 2 },
    });
    const err = new Error("boom");
    const d = classifyFailure(err, 1, c);
    expect(autoDisableContext("my-loop", d, err)).toEqual({
      loopId: "my-loop",
      consecutiveErrors: 2,
      lastError: err,
    });
  });
});
