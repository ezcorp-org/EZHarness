/**
 * The shared resumption registry for tools answered over HTTP
 * (`runtime/remote-tool-registry.ts`).
 *
 * The registry is what makes parallel remote tool calls safe, so this suite
 * is mostly about CONCURRENCY (spec §3.7) rather than about one call's happy
 * path:
 *
 *   - N sibling calls of the same run coexist and settle independently — the
 *     agent loop issues parallel tool calls by default, so a registry that
 *     collapsed on anything but `toolCallId` would cross-resolve them.
 *   - Every entry records the run that opened it, because ONE conversation
 *     can host two live runs and a client must be able to drop its pending
 *     list per-run on that run's terminal event.
 *   - Deleting an entry (resolve / reject / clear / abort) also kills its
 *     timer, so a settled call can never be re-settled by a late timeout.
 *   - Late and double POSTs are no-ops that report themselves as such.
 *
 * Clock note: the one timeout test drives a 1 ms budget and awaits the
 * rejection, so it asserts the ORDERING (timer fires ⇒ promise rejects with
 * the supplied message), never a duration. Nothing here measures the host.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  abortPendingRemoteToolsForConversation,
  clearPendingRemoteTool,
  getPendingRemoteTool,
  getPendingRemoteToolsForConversation,
  registerPendingRemoteTool,
  rejectRemoteTool,
  resolveRemoteTool,
  _resetPendingRemoteToolsForTests,
  type RegisterPendingRemoteToolOptions,
} from "../runtime/remote-tool-registry";

afterEach(() => {
  _resetPendingRemoteToolsForTests();
});

/** A registration with every field a real caller-tool wire supplies. */
function register(
  overrides: Partial<RegisterPendingRemoteToolOptions> & { toolCallId: string },
): Promise<unknown> {
  return registerPendingRemoteTool({
    conversationId: "conv-1",
    userId: "user-1",
    toolName: "open_app",
    runId: "run-1",
    origin: "caller",
    timeoutMs: 60_000,
    timeoutMessage: "timed out",
    ...overrides,
  });
}

/** Settle-state of a promise without racing a timer: a microtask flush is
 *  enough because every settle path in this module resolves synchronously. */
async function settled(p: Promise<unknown>): Promise<
  { state: "pending" } | { state: "resolved"; value: unknown } | { state: "rejected"; error: string }
> {
  let outcome:
    | { state: "pending" }
    | { state: "resolved"; value: unknown }
    | { state: "rejected"; error: string } = { state: "pending" };
  p.then(
    (value) => {
      outcome = { state: "resolved", value };
    },
    (error: Error) => {
      outcome = { state: "rejected", error: error.message };
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  return outcome;
}

describe("N parallel calls coexist, keyed only by toolCallId", () => {
  test("three siblings of one run settle independently", async () => {
    const a = register({ toolCallId: "call-a" });
    const b = register({ toolCallId: "call-b" });
    const c = register({ toolCallId: "call-c" });

    expect(resolveRemoteTool("call-b", { ok: true, detail: { which: "b" } })).toBe(true);

    expect(await settled(b)).toEqual({
      state: "resolved",
      value: { ok: true, detail: { which: "b" } },
    });
    // The siblings are untouched — neither settled nor dropped.
    expect(await settled(a)).toEqual({ state: "pending" });
    expect(await settled(c)).toEqual({ state: "pending" });
    expect(getPendingRemoteTool("call-a")).toBeDefined();
    expect(getPendingRemoteTool("call-b")).toBeUndefined();
    expect(getPendingRemoteTool("call-c")).toBeDefined();

    rejectRemoteTool("call-a", "abandoned");
    rejectRemoteTool("call-c", "abandoned");
    expect(await settled(a)).toEqual({ state: "rejected", error: "abandoned" });
    expect(await settled(c)).toEqual({ state: "rejected", error: "abandoned" });
  });

  test("rejecting one sibling leaves the others resolvable", async () => {
    const a = register({ toolCallId: "sib-a" });
    const b = register({ toolCallId: "sib-b" });
    rejectRemoteTool("sib-a", new Error("device offline"));
    expect(await settled(a)).toEqual({ state: "rejected", error: "device offline" });

    resolveRemoteTool("sib-b", "plain string result");
    expect(await settled(b)).toEqual({ state: "resolved", value: "plain string result" });
  });

  test("a duplicate toolCallId supersedes the prior promise, naming the origin", async () => {
    const first = register({ toolCallId: "dup" });
    const second = register({ toolCallId: "dup" });

    expect(await settled(first)).toEqual({
      state: "rejected",
      error: "caller tool call superseded by a new registration",
    });
    expect(await settled(second)).toEqual({ state: "pending" });
    // The LIVE entry is the second one.
    resolveRemoteTool("dup", { ok: true });
    expect(await settled(second)).toEqual({ state: "resolved", value: { ok: true } });
  });
});

describe("per-run stamping", () => {
  test("two runs on one conversation keep their own entries", () => {
    register({ toolCallId: "r1-a", runId: "run-1" });
    register({ toolCallId: "r2-a", runId: "run-2" });
    register({ toolCallId: "r1-b", runId: "run-1" });

    const all = getPendingRemoteToolsForConversation("conv-1");
    expect(all.map((e) => e.toolCallId)).toEqual(["r1-a", "r2-a", "r1-b"]);
    expect(all.filter((e) => e.runId === "run-1").map((e) => e.toolCallId)).toEqual([
      "r1-a",
      "r1-b",
    ]);
    expect(all.filter((e) => e.runId === "run-2").map((e) => e.toolCallId)).toEqual(["r2-a"]);
  });

  test("an entry without a run records null rather than inventing one", () => {
    register({ toolCallId: "ez-1", runId: null, origin: "ez", toolName: "read_page" });
    expect(getPendingRemoteTool("ez-1")).toMatchObject({
      runId: null,
      origin: "ez",
      toolName: "read_page",
    });
  });

  test("the public view carries no settle handles", () => {
    register({ toolCallId: "opaque" });
    expect(Object.keys(getPendingRemoteTool("opaque") ?? {}).sort()).toEqual([
      "conversationId",
      "createdAt",
      "origin",
      "runId",
      "toolName",
      "userId",
    ]);
  });
});

describe("per-conversation sweeps", () => {
  test("the drain is scoped to one conversation and ordered oldest-first", () => {
    register({ toolCallId: "c1-a", conversationId: "conv-1" });
    register({ toolCallId: "c2-a", conversationId: "conv-2" });
    register({ toolCallId: "c1-b", conversationId: "conv-1" });

    expect(
      getPendingRemoteToolsForConversation("conv-1").map((e) => e.toolCallId),
    ).toEqual(["c1-a", "c1-b"]);
    expect(
      getPendingRemoteToolsForConversation("conv-2").map((e) => e.toolCallId),
    ).toEqual(["c2-a"]);
    expect(getPendingRemoteToolsForConversation("conv-nope")).toEqual([]);
  });

  test("the drain narrows by origin so one family never sees the other's calls", () => {
    register({ toolCallId: "caller-1", origin: "caller" });
    register({ toolCallId: "ez-1", origin: "ez", runId: null });

    expect(
      getPendingRemoteToolsForConversation("conv-1", "caller").map((e) => e.toolCallId),
    ).toEqual(["caller-1"]);
    expect(
      getPendingRemoteToolsForConversation("conv-1", "ez").map((e) => e.toolCallId),
    ).toEqual(["ez-1"]);
  });

  test("abort rejects every entry on the conversation and reports the count", async () => {
    const a = register({ toolCallId: "gone-a" });
    const b = register({ toolCallId: "gone-b" });
    const other = register({ toolCallId: "stays", conversationId: "conv-2" });

    expect(abortPendingRemoteToolsForConversation("conv-1", "declarations revoked")).toBe(2);
    expect(await settled(a)).toEqual({ state: "rejected", error: "declarations revoked" });
    expect(await settled(b)).toEqual({ state: "rejected", error: "declarations revoked" });
    expect(await settled(other)).toEqual({ state: "pending" });
    expect(getPendingRemoteToolsForConversation("conv-1")).toEqual([]);

    rejectRemoteTool("stays", "cleanup");
    expect(await settled(other)).toEqual({ state: "rejected", error: "cleanup" });
  });

  test("abort narrows by origin, and reports zero when nothing matches", async () => {
    const caller = register({ toolCallId: "abort-caller", origin: "caller" });
    const ez = register({ toolCallId: "abort-ez", origin: "ez", runId: null });

    expect(abortPendingRemoteToolsForConversation("conv-1", "revoked", "caller")).toBe(1);
    expect(await settled(caller)).toEqual({ state: "rejected", error: "revoked" });
    expect(await settled(ez)).toEqual({ state: "pending" });
    expect(abortPendingRemoteToolsForConversation("conv-1", "revoked", "caller")).toBe(0);

    rejectRemoteTool("abort-ez", "cleanup");
    expect(await settled(ez)).toEqual({ state: "rejected", error: "cleanup" });
  });
});

describe("late, double and unknown settlements", () => {
  test("resolve/reject/clear on an unknown id are no-ops that say so", () => {
    expect(resolveRemoteTool("never-registered", { ok: true })).toBe(false);
    expect(rejectRemoteTool("never-registered", "nope")).toBe(false);
    expect(getPendingRemoteTool("never-registered")).toBeUndefined();
    // clear returns void; the proof it is a no-op is that nothing throws and
    // the map stays empty.
    clearPendingRemoteTool("never-registered");
    expect(getPendingRemoteToolsForConversation("conv-1")).toEqual([]);
  });

  test("a second POST for the same call reports resolved:false", async () => {
    const p = register({ toolCallId: "double" });
    expect(resolveRemoteTool("double", { ok: true, detail: { n: 1 } })).toBe(true);
    // Two devices hold the same key; the first POST wins, the second is told.
    expect(resolveRemoteTool("double", { ok: true, detail: { n: 2 } })).toBe(false);
    expect(await settled(p)).toEqual({
      state: "resolved",
      value: { ok: true, detail: { n: 1 } },
    });
  });

  test("clear drops the entry without settling the promise", async () => {
    const p = register({ toolCallId: "cleared" });
    clearPendingRemoteTool("cleared");
    expect(getPendingRemoteTool("cleared")).toBeUndefined();
    expect(await settled(p)).toEqual({ state: "pending" });
    // And a resolve afterwards cannot reach it.
    expect(resolveRemoteTool("cleared", { ok: true })).toBe(false);
  });
});

describe("the timeout", () => {
  test("expiry rejects with the family's own message and drops the entry", async () => {
    const p = register({ toolCallId: "slow", timeoutMs: 1, timeoutMessage: "device never answered" });
    await expect(p).rejects.toThrow("device never answered");
    expect(getPendingRemoteTool("slow")).toBeUndefined();
  });

  test("a settled entry's timer cannot fire onto it later", async () => {
    const p = register({ toolCallId: "raced", timeoutMs: 1, timeoutMessage: "would-be timeout" });
    resolveRemoteTool("raced", { ok: true, detail: { won: "the race" } });
    // Give the 1 ms timer every chance to fire against a settled promise.
    await new Promise<void>((r) => setTimeout(r, 5));
    await expect(p).resolves.toEqual({ ok: true, detail: { won: "the race" } });
  });
});

describe("the test reset", () => {
  test("wipes every entry and its timer", async () => {
    const p = register({ toolCallId: "wiped", timeoutMs: 1, timeoutMessage: "should never fire" });
    _resetPendingRemoteToolsForTests();
    expect(getPendingRemoteTool("wiped")).toBeUndefined();
    await new Promise<void>((r) => setTimeout(r, 5));
    // The promise stays pending forever rather than rejecting — the reset is
    // a test-harness wipe, not a settlement path.
    expect(await settled(p)).toEqual({ state: "pending" });
  });
});
