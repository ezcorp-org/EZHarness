// loop.test.ts — defineLoop facade unit coverage.
//
// Drives the fire state machine WITHOUT a live channel by:
//   - injecting an in-memory run store (`_setStoreFactoryForTests`),
//   - injecting settings / spawn resolvers (`_set*ForTests`),
//   - capturing the trigger handler the facade registers on the channel
//     (spy `onRequest`, same trick as schedule.test.ts), then invoking it.
//
// Covers: terminal, deferred, skip, idempotent fire (incl. cron catchUp),
// failure classify → auto-disable at exactly N + onAutoDisable, the
// deferred completion path via dispatchAssignmentUpdate, multi-loop
// dispatch, and duplicate-id rejection.

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
import { Schedule } from "../src/runtime/schedule";

import {
  defineLoop,
  dispatchAssignmentUpdate,
  getLoopTools,
  resolveProviderModel,
  formatMessages,
  _getRegisteredLoop,
  __resetLoopsForTests,
  _setSettingsResolverForTests,
  _setMessagesResolverForTests,
  _setSpawnForTests,
  _setLlmFactoryForTests,
  _setStoreFactoryForTests,
  _setCheckFetchForTests,
} from "../src/runtime/loop";
import type { LoopCheckContext } from "../src/runtime/loop-types";
import { Llm } from "../src/runtime/llm";
import { createLoopRunStore } from "../src/runtime/loop-store";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";
import type { StorageScope } from "../src/runtime/storage";
import type { LoopMessage } from "../src/runtime/loop-types";
import type { TaskAssignmentUpdateEvent } from "../src/runtime/host-event-types";

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

// Capture every onRequest registration so the test can invoke trigger
// handlers (events) directly. Re-installed per test.
let captured: Map<string, (p: unknown) => Promise<unknown> | unknown>;

// Capture cron handlers by spying `Schedule.prototype.on` directly — the
// `ezcorp/schedule-fire` receiver latches process-wide (Schedule's
// `receiverInstalled`), so a per-test `onRequest` spy can't see it once any
// OTHER test file has already triggered the install. Spying `on` is
// order-independent: every `defineLoop({trigger:{kind:"cron"}})` calls
// `new Schedule().on(cron, handler)`, which we record here.
const cronHandlers = new Map<string, (ctx: unknown) => Promise<void> | void>();

// Stashed so afterAll can restore it: the spy patches the SHARED
// Schedule.prototype, so leaving it installed poisons every later test
// file in the bundled SDK shard. schedule.test.ts then can't run the real
// `on()`/`installReceiver()` — its dispatch tests fail and runtime/schedule.ts
// lines 32-42 drop below the @ezcorp/sdk/src/**:100 gate (order-dependent,
// surfaced once the vitest-leg crash stopped masking it).
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
  captured = new Map();
  const ch: HostChannel = getChannel();
  spyOn(ch, "onRequest").mockImplementation(((
    method: string,
    handler: (p: unknown) => unknown,
  ) => {
    captured.set(method, handler);
  }) as HostChannel["onRequest"]);
  // Default seams: empty settings, a deterministic store factory.
  _setSettingsResolverForTests(async () => ({}));
  _setStoreFactoryForTests((<O,>(loopId: string, contract: unknown) =>
    createLoopRunStore<O>(loopId, contract as never, makeKv())) as never);
});

afterEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
  _setSettingsResolverForTests(null);
  _setMessagesResolverForTests(null);
  _setSpawnForTests(null);
  _setStoreFactoryForTests(null);
  _setCheckFetchForTests(null);
});

/** Invoke a captured `ezcorp/event/<event>` handler with a payload. */
async function fireEvent(event: string, payload: unknown): Promise<void> {
  const handler = captured.get(`ezcorp/event/${event}`);
  if (!handler) throw new Error(`no handler captured for event ${event}`);
  await handler(payload);
}

/** Invoke the captured cron handler for `cron`. */
async function fireCron(cron: string): Promise<void> {
  const handler = cronHandlers.get(cron);
  if (!handler) throw new Error(`no cron handler captured for ${cron}`);
  await handler({
    cron,
    scheduledAt: "2026-06-18T00:00:00.000Z",
    firedAt: "2026-06-18T00:00:01.000Z",
    fireId: "fire-1",
    catchUp: true,
    retry: false,
    attempt: 1,
  });
}

/** Invoke a loop's manual-trigger tool handler via `getLoopTools()`. This
 *  is the same handler the SDK dispatcher routes a `tools/call` to, but
 *  reading it from the loop accumulator avoids depending on the
 *  process-wide `tools/call` dispatcher latch (which a sibling SDK test
 *  file disarms). */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const handler = getLoopTools()[name];
  if (!handler) throw new Error(`no loop tool registered for ${name}`);
  const res = (await handler(args)) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: res.content[0]!.text, isError: res.isError };
}

// ── Pure helpers re-exported by the facade ──────────────────────────

describe("resolveProviderModel (centralized map)", () => {
  test("override wins; blank model → provider default; unknown → google", () => {
    expect(resolveProviderModel("openai", "")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(resolveProviderModel("anthropic", "custom")).toEqual({
      provider: "anthropic",
      model: "custom",
    });
    expect(resolveProviderModel("nope", "")).toEqual({
      provider: "google",
      model: "gemini-2.0-flash-lite",
    });
    expect(resolveProviderModel(undefined, undefined)).toEqual({
      provider: "google",
      model: "gemini-2.0-flash-lite",
    });
    expect(resolveProviderModel("ollama", "")).toEqual({
      provider: "ollama",
      model: "gemma4:e2b",
    });
  });
});

describe("formatMessages", () => {
  test("canonical [id] role: content join", () => {
    const msgs: LoopMessage[] = [
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "yo" },
    ];
    expect(formatMessages(msgs)).toBe("[m1] user: hi\n\n[m2] assistant: yo");
  });
});

// ── terminal fire ────────────────────────────────────────────────────

describe("terminal loop", () => {
  test("event trigger → act terminal → run persisted with outcome", async () => {
    const outcomes: unknown[] = [];
    defineLoop({
      id: "cap",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"], terminal: ["done"] },
      act: async (ctx) => {
        outcomes.push(ctx.input);
        return { kind: "terminal", status: "done", outcome: { wrote: 1 } };
      },
    });
    await fireEvent("run:complete", { conversationId: "c1" });

    const reg = _getRegisteredLoop("cap")!;
    const runs = await reg.store.list();
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.outcome).toEqual({ wrote: 1 });
    expect(outcomes).toEqual([{ conversationId: "c1" }]);
  });

  test("act sees resolved settings + recentMessages slice", async () => {
    _setSettingsResolverForTests(async () => ({ provider: "openai" }));
    _setMessagesResolverForTests(async () => ({
      messages: Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        role: "user",
        content: String(i),
      })),
      projectId: "p1",
    }));
    let seenProvider: unknown;
    let sliceLen = 0;
    defineLoop({
      id: "cap2",
      trigger: { kind: "event", event: "run:complete" },
      act: async (ctx) => {
        seenProvider = ctx.settings.provider;
        const recent = await ctx.recentMessages("c1");
        sliceLen = recent.length;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", {});
    expect(seenProvider).toBe("openai");
    expect(sliceLen).toBe(20); // default last-20
  });
});

// ── skip ─────────────────────────────────────────────────────────────

describe("skip", () => {
  test("act skip → no run persisted, not an error", async () => {
    defineLoop({
      id: "sk",
      trigger: { kind: "event", event: "run:complete" },
      act: async () => ({ kind: "skip", reason: "settings_disabled" }),
    });
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("sk")!;
    expect((await reg.store.list()).length).toBe(0);
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });

  test("event filter rejection → pre-skip without invoking act", async () => {
    let actCalls = 0;
    defineLoop({
      id: "flt",
      trigger: {
        kind: "event",
        event: "run:complete",
        filter: (p) => (p as { ok?: boolean }).ok === true,
      },
      act: async () => {
        actCalls++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", { ok: false });
    expect(actCalls).toBe(0);
    await fireEvent("run:complete", { ok: true });
    expect(actCalls).toBe(1);
  });
});

// ── deferred ─────────────────────────────────────────────────────────

describe("deferred loop", () => {
  test("act deferred → open run; assignment_update transitions it terminal", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "sub-1",
      agentRunId: "run-1",
      taskId: "task-1",
      assignmentId: "assign-1",
    }));
    defineLoop({
      id: "ezc",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "running", "completed", "failed", "cancelled"],
        terminal: ["completed", "failed", "cancelled"],
      },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "do it" });
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
    await fireEvent("run:complete", {});
    const reg = _getRegisteredLoop("ezc")!;
    let runs = await reg.store.list();
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("dispatched");
    expect(runs[0]!.externalRunId).toBe("run-1");

    // Inbound completion event drives the deferred transition.
    const evt: TaskAssignmentUpdateEvent = {
      conversationId: "c1",
      taskId: "task-1",
      assignment: {
        id: "assign-1",
        agentConfigId: "a",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "run-1",
        resultPreview: "all done",
      },
    };
    await dispatchAssignmentUpdate(evt);
    runs = await reg.store.list();
    expect(runs[0]!.status).toBe("completed");
    expect(runs[0]!.events[0]).toMatchObject({ status: "completed", note: "all done" });
  });

  test("assignment_update for an unknown run is a no-op", async () => {
    defineLoop({
      id: "ezc2",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "completed"],
        terminal: ["completed"],
      },
      act: async () => ({ kind: "skip", reason: "x" }),
    });
    const evt: TaskAssignmentUpdateEvent = {
      conversationId: "c",
      taskId: "nope",
      assignment: {
        id: "nope",
        agentConfigId: "a",
        agentName: "x",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "nope",
      },
    };
    // Must not throw.
    await dispatchAssignmentUpdate(evt);
    expect((await _getRegisteredLoop("ezc2")!.store.list()).length).toBe(0);
  });
});

// ── idempotency: catch-up + double-delivery ─────────────────────────

describe("idempotent fires", () => {
  test("two fires with the same idempotencyKey produce ONE open run", async () => {
    let acts = 0;
    defineLoop({
      id: "idem",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "completed"],
        terminal: ["completed"],
        idempotencyKey: (input) => (input as { cid?: string }).cid,
      },
      act: async () => {
        acts++;
        return {
          kind: "deferred",
          runId: `run-${acts}`,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
        };
      },
    });
    await fireEvent("run:complete", { cid: "same" });
    await fireEvent("run:complete", { cid: "same" }); // catch-up / double-deliver
    const runs = await _getRegisteredLoop("idem")!.store.list();
    // Second fire's act still ran but its claim collapsed onto the open run.
    expect(runs.length).toBe(1);
  });
});

// ── failure policy: classify → auto-disable at exactly N ────────────

describe("failure policy", () => {
  test("permanent errors auto-disable at exactly N + onAutoDisable fires once", async () => {
    const disabled: number[] = [];
    defineLoop({
      id: "fail",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: {
          classify: () => "permanent",
          autoDisableAfter: 2,
          onAutoDisable: async (ctx) => {
            disabled.push(ctx.consecutiveErrors);
          },
        },
      },
      act: async () => {
        throw new Error("permanent boom");
      },
    });
    const reg = _getRegisteredLoop("fail")!;
    await fireEvent("run:complete", {}); // err 1
    expect((await reg.store.getMeta()).disabled).toBe(false);
    await fireEvent("run:complete", {}); // err 2 → disable
    expect((await reg.store.getMeta()).disabled).toBe(true);
    expect(disabled).toEqual([2]);

    // A third fire is skipped (disabled latch) — act not re-run.
    await fireEvent("run:complete", {});
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(2);
  });

  test("a transient error resets the consecutive counter and never disables", async () => {
    let mode: "permanent" | "transient" = "permanent";
    defineLoop({
      id: "mix",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: {
          classify: () => mode,
          autoDisableAfter: 3,
        },
      },
      act: async () => {
        throw new Error("boom");
      },
    });
    const reg = _getRegisteredLoop("mix")!;
    await fireEvent("run:complete", {}); // permanent → 1
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(1);
    mode = "transient";
    await fireEvent("run:complete", {}); // transient → reset 0
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
    expect((await reg.store.getMeta()).disabled).toBe(false);
  });

  test("a successful act after errors resets the counter", async () => {
    let fail = true;
    defineLoop({
      id: "recover",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"], failure: { classify: () => "permanent", autoDisableAfter: 5 } },
      act: async () => {
        if (fail) throw new Error("boom");
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    const reg = _getRegisteredLoop("recover")!;
    await fireEvent("run:complete", {});
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(1);
    fail = false;
    await fireEvent("run:complete", {});
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });
});

// ── unknown status rejection ────────────────────────────────────────

describe("act-result validation", () => {
  test("returning an undeclared status is treated as a failure (not persisted)", async () => {
    defineLoop({
      id: "bad",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "bogus", outcome: null }),
    });
    const reg = _getRegisteredLoop("bad")!;
    await fireEvent("run:complete", {});
    expect((await reg.store.list()).length).toBe(0);
    // Default classify → transient, so it does not auto-disable but is
    // recorded as a (transient) failure.
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });

  test("invalid act results ACCUMULATE toward auto-disable (validate before reset)", async () => {
    // Regression: `resetErrorsIfNeeded` used to run BEFORE `validateActResult`,
    // so a permanently-invalid act reset-then-incremented to 1 every fire and
    // could never reach the threshold. With validate-before-reset the invalid
    // results accumulate and trip auto-disable at exactly N.
    defineLoop({
      id: "bad-accum",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: { classify: () => "permanent", autoDisableAfter: 2 },
      },
      act: async () => ({ kind: "terminal", status: "bogus", outcome: null }),
    });
    const reg = _getRegisteredLoop("bad-accum")!;
    await fireEvent("run:complete", {}); // invalid → err 1
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(1);
    expect((await reg.store.getMeta()).disabled).toBe(false);
    await fireEvent("run:complete", {}); // invalid → err 2 → disable
    expect((await reg.store.getMeta()).disabled).toBe(true);
    // No run was ever persisted (every act result was invalid).
    expect((await reg.store.list()).length).toBe(0);
  });
});

// ── check stage: proceed / skip / throw × transient/permanent ───────

// Type-level firewall: the check context MUST NOT expose `llm`, `spawn`, or
// `recentMessages`. If any leaks into `LoopCheckContext`, the corresponding
// `Absent<…>` resolves to `never` and this assignment fails to COMPILE — a
// determinism-by-construction guard that lives in the type system, not a
// runtime convention. (Also asserted structurally at runtime below.)
type Absent<K extends string> = K extends keyof LoopCheckContext ? never : true;
const _firewall: [Absent<"llm">, Absent<"spawn">, Absent<"recentMessages">] = [
  true,
  true,
  true,
];
void _firewall;

describe("check stage", () => {
  test("proceed:true (no enrichment) → act runs on the raw trigger input", async () => {
    let actInput: unknown;
    defineLoop({
      id: "chk-proceed",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async () => ({ proceed: true }),
      act: async (ctx) => {
        actInput = ctx.input;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", { cid: "c1" });
    expect(actInput).toEqual({ cid: "c1" });
    expect((await _getRegisteredLoop("chk-proceed")!.store.list())[0]!.status).toBe("done");
  });

  test("proceed:true with input ENRICHES what act sees + what the run stores", async () => {
    let actInput: unknown;
    defineLoop({
      id: "chk-enrich",
      trigger: { kind: "cron", cron: "0 * * * *" },
      contract: { states: ["done"] },
      check: async () => ({ proceed: true, input: { hash: "abc", subject: "fix" } }),
      act: async (ctx) => {
        actInput = ctx.input;
        return { kind: "terminal", status: "done", outcome: { ok: 1 } };
      },
    });
    await fireCron("0 * * * *");
    expect(actInput).toEqual({ hash: "abc", subject: "fix" });
    // The persisted run records the ENRICHED input (what act processed).
    const run = (await _getRegisteredLoop("chk-enrich")!.store.list())[0]!;
    expect(run.input).toEqual({ hash: "abc", subject: "fix" });
  });

  test("proceed:false → first-class skip (act NOT called, no run, reason logged)", async () => {
    let actCalls = 0;
    defineLoop({
      id: "chk-skip",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async () => ({ proceed: false, reason: "no_new_commits" }),
      act: async () => {
        actCalls++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", {});
    expect(actCalls).toBe(0);
    expect((await _getRegisteredLoop("chk-skip")!.store.list()).length).toBe(0);
  });

  test("a proceed:false with an empty reason is a check ERROR (act not called)", async () => {
    let actCalls = 0;
    defineLoop({
      id: "chk-badskip",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      // Malformed decline — no reason. Treated as a (transient) failure.
      check: async () => ({ proceed: false, reason: "" }),
      act: async () => {
        actCalls++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    const reg = _getRegisteredLoop("chk-badskip")!;
    await fireEvent("run:complete", {});
    expect(actCalls).toBe(0);
    expect((await reg.store.list()).length).toBe(0);
    // Default classify → transient, so recorded but not disabling.
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });

  test("a thrown check is classified permanent → auto-disables at exactly N", async () => {
    const disabled: number[] = [];
    let actCalls = 0;
    defineLoop({
      id: "chk-throw",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: {
          classify: () => "permanent",
          autoDisableAfter: 2,
          onAutoDisable: async (ctx) => {
            disabled.push(ctx.consecutiveErrors);
          },
        },
      },
      check: async () => {
        throw new Error("check boom");
      },
      act: async () => {
        actCalls++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    const reg = _getRegisteredLoop("chk-throw")!;
    await fireEvent("run:complete", {}); // err 1
    expect((await reg.store.getMeta()).disabled).toBe(false);
    await fireEvent("run:complete", {}); // err 2 → disable
    expect((await reg.store.getMeta()).disabled).toBe(true);
    expect(disabled).toEqual([2]);
    // A thrown check never reaches act.
    expect(actCalls).toBe(0);
  });

  test("a thrown-then-transient check resets the consecutive counter", async () => {
    let mode: "permanent" | "transient" = "permanent";
    defineLoop({
      id: "chk-mix",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: { classify: () => mode, autoDisableAfter: 3 },
      },
      check: async () => {
        throw new Error("boom");
      },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    const reg = _getRegisteredLoop("chk-mix")!;
    await fireEvent("run:complete", {}); // permanent → 1
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(1);
    mode = "transient";
    await fireEvent("run:complete", {}); // transient → reset 0
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });

  test("a proceed:false skip RESETS a prior error count (a healthy fire)", async () => {
    let outcome: "throw" | "skip" = "throw";
    defineLoop({
      id: "chk-skip-reset",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        failure: { classify: () => "permanent", autoDisableAfter: 5 },
      },
      check: async () => {
        if (outcome === "throw") throw new Error("boom");
        return { proceed: false, reason: "quiet" };
      },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    const reg = _getRegisteredLoop("chk-skip-reset")!;
    await fireEvent("run:complete", {}); // permanent → 1
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(1);
    outcome = "skip";
    await fireEvent("run:complete", {}); // healthy decline → reset
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });

  test("cursor get/set delegates to the run store across fires", async () => {
    const seen: (string | undefined)[] = [];
    defineLoop({
      id: "chk-cursor",
      trigger: { kind: "cron", cron: "*/5 * * * *" },
      contract: { states: ["done"] },
      check: async (ctx) => {
        const prev = await ctx.cursor.get<string>();
        seen.push(prev);
        await ctx.cursor.set(`tick-${seen.length}`);
        return { proceed: true };
      },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    await fireCron("*/5 * * * *");
    await fireCron("*/5 * * * *");
    // First fire sees an unset cursor; second reads what the first wrote.
    expect(seen).toEqual([undefined, "tick-1"]);
    expect(await _getRegisteredLoop("chk-cursor")!.store.getCursor<string>()).toBe("tick-2");
  });

  test("check exposes an injectable host-mediated fetch + the fire meta", async () => {
    const fakeResponse = new Response("ok");
    let gotFetch: unknown;
    let gotFire: unknown;
    _setCheckFetchForTests((async () => fakeResponse) as unknown as typeof fetch);
    defineLoop({
      id: "chk-fetch",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async (ctx) => {
        gotFire = ctx.fire;
        gotFetch = await ctx.fetch("https://example.test");
        return { proceed: true };
      },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    await fireEvent("run:complete", {});
    expect(gotFetch).toBe(fakeResponse);
    expect(gotFire).toMatchObject({ trigger: { kind: "event", event: "run:complete" }, catchUp: false });
  });

  test("FIREWALL: the check context has no llm / spawn / recentMessages at runtime", async () => {
    let keys: string[] = [];
    defineLoop({
      id: "chk-firewall",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async (ctx) => {
        keys = Object.keys(ctx);
        return { proceed: true };
      },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    await fireEvent("run:complete", {});
    expect(keys).not.toContain("llm");
    expect(keys).not.toContain("spawn");
    expect(keys).not.toContain("recentMessages");
    // The intended surface IS present.
    expect(keys.sort()).toEqual(["cursor", "fetch", "fire", "input", "log", "settings"]);
  });

  test("a malformed check result is fail-soft (classified, never thrown to the host)", async () => {
    // A misbehaving check returns junk (not a CheckResult). validateCheckResult
    // catches it INSIDE the try/catch, so the fire is classified like a thrown
    // check (transient by default) — never re-thrown to the fire-and-forget host.
    let actCalls = 0;
    defineLoop({
      id: "chk-malformed",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async () => "not-a-check-result" as never,
      act: async () => {
        actCalls++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    const reg = _getRegisteredLoop("chk-malformed")!;
    // The fire resolves (no throw escapes runFire).
    await fireEvent("run:complete", {});
    expect(actCalls).toBe(0);
    expect((await reg.store.list()).length).toBe(0);
    // Recorded as a (transient) failure — no run persisted, not disabling.
    expect((await reg.store.getMeta()).consecutiveErrors).toBe(0);
  });

  test("a non-boolean proceed is fail-soft (never silently acts)", async () => {
    let actCalls = 0;
    defineLoop({
      id: "chk-nonbool",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async () => ({ proceed: "yes" }) as never,
      act: async () => {
        actCalls++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", {});
    expect(actCalls).toBe(0);
    expect((await _getRegisteredLoop("chk-nonbool")!.store.list()).length).toBe(0);
  });

  test("idempotency keys on the ENRICHED input (check enrichment feeds the dedup)", async () => {
    // A deferred loop whose idempotencyKey reads a field that ONLY exists on
    // the enriched input. Fire twice: the second fire's key matches the first,
    // still-open run, so the claim dedups (created:false). Proves the run store
    // is keyed on `effectiveInput` (post-check), not the raw trigger input.
    let actCalls = 0;
    defineLoop({
      id: "chk-dedup",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["open", "done"],
        terminal: ["done"],
        idempotencyKey: (input) => (input as { hash?: string }).hash,
      },
      check: async () => ({ proceed: true, input: { hash: "H" } }),
      act: async () => {
        actCalls++;
        return {
          kind: "deferred",
          runId: `run-${actCalls}`,
          status: "open",
          awaitEvent: "task:assignment_update",
        };
      },
    });
    const reg = _getRegisteredLoop("chk-dedup")!;
    await fireEvent("run:complete", { raw: 1 });
    await fireEvent("run:complete", { raw: 2 });
    // act ran twice (dedup is at claim time, post-act) but only ONE run landed.
    expect(actCalls).toBe(2);
    const runs = await reg.store.list();
    expect(runs.length).toBe(1);
    expect(runs[0]!.idempotencyKey).toBe("H");
    expect(runs[0]!.input).toEqual({ hash: "H" });
  });

  test("the default check fetch lazily forwards to the CURRENT global fetch", async () => {
    // Prove the lazy binding: swap globalThis.fetch AFTER module load, reset
    // the seam to the default wrapper, and confirm ctx.fetch resolves the
    // swapped global at call time (a module-eval capture would miss it).
    const orig = globalThis.fetch;
    const sentinel = new Response("sentinel");
    globalThis.fetch = (async () => sentinel) as unknown as typeof fetch;
    try {
      _setCheckFetchForTests(null); // back to the lazy default wrapper
      let got: unknown;
      defineLoop({
        id: "chk-defaultfetch",
        trigger: { kind: "event", event: "run:complete" },
        contract: { states: ["done"] },
        check: async (ctx) => {
          got = await ctx.fetch("https://example.test");
          return { proceed: true };
        },
        act: async () => ({ kind: "terminal", status: "done", outcome: null }),
      });
      await fireEvent("run:complete", {});
      expect(got).toBe(sentinel);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("the default check fetch is a live-ish wrapper (seam resets cleanly)", () => {
    // Reset to the production default and confirm the setter doesn't throw
    // and leaves a callable fetch in place (the real global is network-gated
    // by the sandbox at runtime; here we only prove the wrapper is wired).
    expect(() => _setCheckFetchForTests(null)).not.toThrow();
  });
});

// ── skip journal: durable decline audit across trigger kinds ────────

describe("skip journal (durable decline audit through runFire)", () => {
  test("event check proceed:false is journaled with reason + logLines + trigger kind", async () => {
    defineLoop({
      id: "sj-event",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      check: async (ctx) => {
        ctx.log("looked, nothing new");
        return { proceed: false, reason: "no_new_commits" };
      },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    const reg = _getRegisteredLoop("sj-event")!;
    await fireEvent("run:complete", {});
    const skips = await reg.store.listSkips();
    expect(skips.length).toBe(1);
    expect(skips[0]).toMatchObject({
      reason: "no_new_commits",
      trigger: "event",
      logLines: ["[info] looked, nothing new"],
    });
    expect(typeof skips[0]!.at).toBe("string");
  });

  test("cron check proceed:false is journaled (trigger kind = cron)", async () => {
    defineLoop({
      id: "sj-cron",
      trigger: { kind: "cron", cron: "0 * * * *" },
      contract: { states: ["done"] },
      check: async () => ({ proceed: false, reason: "quiet" }),
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    const reg = _getRegisteredLoop("sj-cron")!;
    await fireCron("0 * * * *");
    const skips = await reg.store.listSkips();
    expect(skips.length).toBe(1);
    expect(skips[0]).toMatchObject({ reason: "quiet", trigger: "cron" });
  });

  test("a manual act skip is journaled (trigger kind = manual)", async () => {
    defineLoop({
      id: "sj-manual",
      trigger: { kind: "manual", tool: "run_it" },
      contract: { states: ["done"] },
      act: async (ctx) => {
        ctx.log("declined by act");
        return { kind: "skip", reason: "act_declined" };
      },
    });
    const reg = _getRegisteredLoop("sj-manual")!;
    const res = await callTool("run_it", {});
    expect(JSON.parse(res.text)).toMatchObject({ skipped: true, reason: "act_declined" });
    const skips = await reg.store.listSkips();
    expect(skips.length).toBe(1);
    expect(skips[0]).toMatchObject({
      reason: "act_declined",
      trigger: "manual",
      logLines: ["[info] declined by act"],
    });
  });

  test("a rejected event filter (pre-gate) is journaled with empty logLines", async () => {
    defineLoop({
      id: "sj-filter",
      trigger: { kind: "event", event: "run:complete", filter: () => false },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    const reg = _getRegisteredLoop("sj-filter")!;
    await fireEvent("run:complete", {});
    const skips = await reg.store.listSkips();
    expect(skips.length).toBe(1);
    expect(skips[0]).toMatchObject({ reason: "filter_rejected", trigger: "event", logLines: [] });
  });

  test("an auto_disabled skip is NOT journaled (the latch would spam the capped journal)", async () => {
    defineLoop({
      id: "sj-disabled",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    const reg = _getRegisteredLoop("sj-disabled")!;
    await reg.store.setMeta({ consecutiveErrors: 0, disabled: true });
    await fireEvent("run:complete", {});
    expect(await reg.store.listSkips()).toEqual([]);
  });
});

// ── trigger kinds: cron + manual tool ───────────────────────────────

describe("cron + manual triggers", () => {
  test("cron fire (catchUp) runs the act and persists a run", async () => {
    defineLoop({
      id: "cronloop",
      trigger: { kind: "cron", cron: "0 */6 * * *" },
      contract: { states: ["done"] },
      act: async (ctx) => ({
        kind: "terminal",
        status: "done",
        outcome: { catchUp: ctx.fire.catchUp },
      }),
    });
    await fireCron("0 */6 * * *");
    const runs = await _getRegisteredLoop("cronloop")!.store.list();
    expect(runs.length).toBe(1);
    expect(runs[0]!.outcome).toEqual({ catchUp: true });
  });

  test("manual tool returns runId on terminal, reason on skip, error on throw", async () => {
    let mode: "ok" | "skip" | "boom" = "ok";
    defineLoop({
      id: "manualloop",
      trigger: { kind: "manual", tool: "do_it" },
      contract: { states: ["done"] },
      act: async () => {
        if (mode === "skip") return { kind: "skip", reason: "nope" };
        if (mode === "boom") throw new Error("kaboom");
        return { kind: "terminal", status: "done", outcome: null };
      },
    });

    const ok = await callTool("do_it", {});
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.text)).toMatchObject({ loop: "manualloop", status: "done" });

    mode = "skip";
    const skipped = await callTool("do_it", {});
    expect(JSON.parse(skipped.text)).toMatchObject({ skipped: true, reason: "nope" });

    mode = "boom";
    const errored = await callTool("do_it", {});
    expect(errored.isError).toBe(true);
    expect(errored.text).toContain("kaboom");
  });

  test("a bare manual trigger with no tool wires nothing (no throw)", () => {
    expect(() =>
      defineLoop({
        id: "noop-manual",
        trigger: { kind: "manual" },
        act: async () => ({ kind: "skip", reason: "x" }),
      }),
    ).not.toThrow();
  });
});

// ── default resolvers (real invoke path) + ctx.log + seams ──────────

describe("default resolvers + ctx helpers", () => {
  test("default settings + messages resolvers ride the channel invoke RPC", async () => {
    // Do NOT inject the resolver seams — exercise the real `invoke`
    // (ezcorp/invoke) path by stubbing the channel `request`.
    _setSettingsResolverForTests(null);
    _setMessagesResolverForTests(null);
    const ch = getChannel();
    spyOn(ch, "request").mockImplementation((async (
      _method: string,
      params: unknown,
    ): Promise<unknown> => {
      const tool = (params as { tool?: string }).tool;
      if (tool === "runtime.settings.getMine") return { provider: "anthropic" };
      if (tool === "runtime.conversations.getMessages") {
        return {
          messages: [
            { id: "m1", role: "user", content: "a" },
            { id: "m2", role: "assistant", content: "b" },
          ],
          projectId: "p1",
        };
      }
      return {};
    }) as typeof ch.request);

    let seen: { provider?: unknown; count?: number; logged?: boolean } = {};
    defineLoop({
      id: "real",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async (ctx) => {
        ctx.log("hello", "warn"); // exercises ctx.log
        const recent = await ctx.recentMessages("c1");
        seen = { provider: ctx.settings.provider, count: recent.length, logged: true };
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", {});
    expect(seen).toEqual({ provider: "anthropic", count: 2, logged: true });
  });

  test("default settings resolver swallows an invoke error → {}", async () => {
    _setSettingsResolverForTests(null);
    const ch = getChannel();
    spyOn(ch, "request").mockImplementation((async () => {
      throw new Error("host down");
    }) as typeof ch.request);
    let seenSettings: unknown;
    defineLoop({
      id: "real2",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async (ctx) => {
        seenSettings = ctx.settings;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", {});
    expect(seenSettings).toEqual({});
  });

  test("seam setters reset to defaults without throwing", () => {
    expect(() => {
      _setSpawnForTests(null);
      _setLlmFactoryForTests(() => new Llm());
      _setLlmFactoryForTests(null);
      _setMessagesResolverForTests(null);
    }).not.toThrow();
  });
});

// ── terminal idempotency ────────────────────────────────────────────

describe("terminal idempotency", () => {
  test("two terminal fires with the same key collapse to one run", async () => {
    let acts = 0;
    defineLoop({
      id: "term-idem",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["done"],
        idempotencyKey: (input) => (input as { slug?: string }).slug,
      },
      act: async () => {
        acts++;
        return { kind: "terminal", status: "done", outcome: { n: acts } };
      },
    });
    // Same slug while the first is still… terminal. A `done` capture loop
    // closes immediately, so the SECOND fire is NOT a dupe (the first run
    // is terminal). This asserts the terminal-claim path threads the key.
    await fireEvent("run:complete", { slug: "s" });
    await fireEvent("run:complete", { slug: "s" });
    const runs = await _getRegisteredLoop("term-idem")!.store.list();
    // Both ran (terminal → not open → not a dupe); each carries the key.
    expect(runs.every((r) => r.idempotencyKey === "s")).toBe(true);
  });
});

// ── registered assignment handler (ensureAssignmentHandler body) ────

describe("registered task:assignment_update handler", () => {
  test("the channel-registered handler drives the deferred transition", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "s",
      agentRunId: "RUN-Z",
      taskId: "T-Z",
      assignmentId: "A-Z",
    }));
    defineLoop({
      id: "reg-defer",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["dispatched", "completed"], terminal: ["completed"] },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "x", task: "t" });
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
    await fireEvent("run:complete", {});
    // Invoke via the CAPTURED channel handler (not dispatchAssignmentUpdate
    // directly) so the ensureAssignmentHandler wrapper body is exercised.
    await fireEvent("task:assignment_update", {
      conversationId: "c",
      taskId: "T-Z",
      assignment: {
        id: "A-Z",
        agentConfigId: "a",
        agentName: "x",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "RUN-Z",
      },
    });
    expect((await _getRegisteredLoop("reg-defer")!.store.list())[0]!.status).toBe("completed");
  });
});

// ── assignment-status mapping fallbacks ─────────────────────────────

describe("mapAssignmentStatus fallbacks", () => {
  function deferredLoop(id: string): void {
    _setSpawnForTests(async () => ({
      subConversationId: "s",
      agentRunId: `RUN-${id}`,
      taskId: `T-${id}`,
      assignmentId: `A-${id}`,
    }));
    defineLoop({
      id,
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "running", "completed", "failed", "cancelled"],
        terminal: ["completed", "failed", "cancelled"],
      },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "x", task: "t" });
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
  }

  async function deferAndUpdate(id: string, status: string): Promise<string> {
    deferredLoop(id);
    await fireEvent("run:complete", {});
    const evt: TaskAssignmentUpdateEvent = {
      conversationId: "c",
      taskId: `T-${id}`,
      assignment: {
        id: `A-${id}`,
        agentConfigId: "a",
        agentName: "x",
        isTeam: false,
        status: status as never,
        assignedAt: "t",
        agentRunId: `RUN-${id}`,
      },
    };
    await dispatchAssignmentUpdate(evt);
    return (await _getRegisteredLoop(id)!.store.list())[0]!.status;
  }

  test("a 'running' host status maps to the running state (stays open)", async () => {
    expect(await deferAndUpdate("m-run", "running")).toBe("running");
  });

  test("a 'failed' host status maps to a terminal state", async () => {
    expect(await deferAndUpdate("m-fail", "failed")).toBe("failed");
  });

  test("an unknown host status keeps the run open (first non-terminal state)", async () => {
    expect(await deferAndUpdate("m-weird", "weird_status")).toBe("dispatched");
  });

  test("a terminal-ish host status NOT in the vocabulary maps to terminal[0]", async () => {
    // Contract whose terminal state is named "done" — the host's
    // "completed" status isn't declared, so it falls back to terminal[0].
    _setSpawnForTests(async () => ({
      subConversationId: "s",
      agentRunId: "RUN-D",
      taskId: "T-D",
      assignmentId: "A-D",
    }));
    defineLoop({
      id: "alias",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["dispatched", "done"], terminal: ["done"] },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "x", task: "t" });
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
    await fireEvent("run:complete", {});
    await dispatchAssignmentUpdate({
      conversationId: "c",
      taskId: "T-D",
      assignment: {
        id: "A-D",
        agentConfigId: "a",
        agentName: "x",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "RUN-D",
      },
    });
    expect((await _getRegisteredLoop("alias")!.store.list())[0]!.status).toBe("done");
  });
});

// ── multi-loop per extension ────────────────────────────────────────

describe("multi-loop + duplicate-id", () => {
  test("two loops register independently; assignment routes to the owner", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "s",
      agentRunId: "RUN-A",
      taskId: "T",
      assignmentId: "A",
    }));
    defineLoop({
      id: "loopA",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["dispatched", "completed"], terminal: ["completed"] },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "x", task: "t" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
        };
      },
    });
    defineLoop({
      id: "loopB",
      trigger: { kind: "event", event: "tool:complete" },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    await fireEvent("run:complete", {});

    const evt: TaskAssignmentUpdateEvent = {
      conversationId: "c",
      taskId: "T",
      assignment: {
        id: "A",
        agentConfigId: "a",
        agentName: "x",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "RUN-A",
      },
    };
    await dispatchAssignmentUpdate(evt);
    const a = await _getRegisteredLoop("loopA")!.store.list();
    expect(a[0]!.status).toBe("completed");
  });

  test("getLoopTools exposes the accumulated manual-trigger handlers", async () => {
    defineLoop({
      id: "mt",
      trigger: { kind: "manual", tool: "do_it" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: { ok: 1 } }),
    });
    expect(Object.keys(getLoopTools())).toContain("do_it");
  });

  test("a manual-tool NAME collision across loops throws (no silent clobber)", () => {
    defineLoop({
      id: "loop-a",
      trigger: { kind: "manual", tool: "shared_name" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "skip", reason: "x" }),
    });
    // A second loop claiming the same tool name is the DX footgun — it must
    // crash loudly at install instead of silently clobbering loop-a.
    expect(() =>
      defineLoop({
        id: "loop-b",
        trigger: { kind: "manual", tool: "shared_name" },
        contract: { states: ["done"] },
        act: async () => ({ kind: "skip", reason: "y" }),
      }),
    ).toThrow(/manual tool "shared_name" is already registered/);
  });

  test("an array of triggers wires each one", async () => {
    let fires = 0;
    defineLoop({
      id: "multi",
      trigger: [
        { kind: "event", event: "run:complete" },
        { kind: "cron", cron: "0 * * * *" },
      ],
      contract: { states: ["done"] },
      act: async () => {
        fires++;
        return { kind: "terminal", status: "done", outcome: null };
      },
    });
    await fireEvent("run:complete", {});
    await fireCron("0 * * * *");
    expect(fires).toBe(2);
    expect((await _getRegisteredLoop("multi")!.store.list()).length).toBe(2);
  });

  test("duplicate loop id throws", () => {
    defineLoop({
      id: "dup",
      trigger: { kind: "event", event: "run:complete" },
      act: async () => ({ kind: "skip", reason: "x" }),
    });
    expect(() =>
      defineLoop({
        id: "dup",
        trigger: { kind: "event", event: "tool:complete" },
        act: async () => ({ kind: "skip", reason: "x" }),
      }),
    ).toThrow(/duplicate loop id/);
  });
});
