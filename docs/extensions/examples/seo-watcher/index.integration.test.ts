// seo-watcher — full-flow integration against the REAL loop primitive.
//
// Drives the REAL `defineLoop` facade (check → synchronous act → proposal park
// → approve/decline resolution + the LOCKED approval-label store) end-to-end,
// with only the leaf side effects injected:
//   - an in-memory Storage KV (faithful to the host storage RPC contract) —
//     the run store, cursor, and label store live here;
//   - an injected check `fetch` (the structured endpoint — NO live network);
//   - an injected review `llm` (the recommendation draft, deterministic);
//   - a spying LoopEvents (observe the approval nudges without a channel).
//
// It proves the flagship wiring the unit tests exercise in isolation actually
// composes on the primitive: a manual fire fetches → threshold-trips → drafts +
// parks a proposal; a dashboard Approve row action resolves it through
// `approveRun` and writes the approval label with the HOST-STAMPED `decidedBy`
// (`event.userId`); Decline discards + writes a `declined` label; a lost
// finalize closure (a restart) surfaces `verifyManually` with NO double-publish
// and NO label; and the registration stamps `untrustedInput` (contentTrust).
//
// The loop-primitive test seams are imported by RELATIVE path (not on the
// `@ezcorp/sdk/runtime` public barrel) — the same resolved module the example's
// import binds, so the injected singletons are the ones the fire path reads.

import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { createLoopRunStore, getLoopTools, LoopEvents, type StorageScope } from "@ezcorp/sdk/runtime";
import {
  __resetLoopsForTests,
  _getRegisteredLoop,
  _setStoreFactoryForTests,
  _setSettingsResolverForTests,
  _setLoopEventsForTests,
  _setCheckFetchForTests,
  _setLlmFactoryForTests,
  _setProposalClosuresForTests,
} from "../../../../packages/@ezcorp/sdk/src/runtime/loop";
import { __resetChannelForTests } from "../../../../packages/@ezcorp/sdk/src/runtime/channel";
import type { LoopApprovalLabel, LoopRunState } from "../../../../packages/@ezcorp/sdk/src/runtime/loop-types";
import { defineSeoWatcherLoop, handleApproveAction, handleDeclineAction, LOOP_ID, type SeoOutcome } from "./index";

// ── in-memory Storage (mirrors the host storage RPC contract) ───────

function makeMemStorage() {
  const kv = new Map<string, unknown>();
  const storage = {
    async get<T = unknown>(key: string) {
      return kv.has(key)
        ? { value: kv.get(key) as T, exists: true }
        : { value: null as T | null, exists: false };
    },
    async set<T = unknown>(key: string, value: T) {
      kv.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      return { deleted: kv.delete(key) };
    },
    async list(opts?: { prefix?: string }) {
      const p = opts?.prefix ?? "";
      return { keys: [...kv.keys()].filter((k) => k.startsWith(p)) };
    },
  };
  return { kv, storage };
}

// ── harness ─────────────────────────────────────────────────────────

let kv: Map<string, unknown>;
let events: { pending: unknown[]; resolved: unknown[] };
let endpointBody: string;
let endpointOk: boolean;
let completion: string;

beforeEach(() => {
  __resetLoopsForTests();
  const mem = makeMemStorage();
  kv = mem.kv;
  events = { pending: [], resolved: [] };
  endpointBody = JSON.stringify({ data: { rank: 3 } });
  endpointOk = true;
  completion = "Refresh the landing copy and target the rising keyword.";

  _setStoreFactoryForTests(<O,>(loopId: string, contract: unknown) =>
    createLoopRunStore<O>(loopId, contract as never, (_scope: StorageScope) => mem.storage),
  );
  _setSettingsResolverForTests(async () => ({
    enabled: true,
    endpoint_url: "https://api.example.com/rank",
    metric_pointer: "data.rank",
    threshold_op: "changed",
    metric_label: "Ranking for 'best widgets'",
    llm_provider: "google",
  }));
  _setCheckFetchForTests((async () =>
    new Response(endpointBody, { status: endpointOk ? 200 : 503 })) as unknown as typeof fetch);
  _setLlmFactoryForTests((() => ({
    complete: async () => ({ content: completion }),
  })) as never);
  _setLoopEventsForTests({
    emitApprovalPending: async (p: unknown) => {
      events.pending.push(p);
    },
    emitApprovalResolved: async (p: unknown) => {
      events.resolved.push(p);
    },
    emitAutoDisabled: async () => {},
  } as unknown as LoopEvents);
  defineSeoWatcherLoop();
});

afterEach(() => {
  __resetLoopsForTests();
  _setStoreFactoryForTests(null);
  _setSettingsResolverForTests(null);
  _setCheckFetchForTests(null);
  _setLlmFactoryForTests(null);
  _setLoopEventsForTests(null);
  _setProposalClosuresForTests(LOOP_ID, "*", null);
  __resetChannelForTests();
});

/** Fire the manual tool once and return the parsed report. */
async function fireManual(): Promise<{ runId?: string; status?: string; skipped?: boolean; reason?: string }> {
  const handler = getLoopTools().run_seo_watch!;
  const res = await handler({}, undefined);
  const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

function runOf(runId: string): LoopRunState<SeoOutcome> | undefined {
  return kv.get(`loop:${LOOP_ID}:run:${runId}`) as LoopRunState<SeoOutcome> | undefined;
}
function labels(): LoopApprovalLabel[] {
  return (kv.get(`loop:${LOOP_ID}:labels`) as LoopApprovalLabel[] | undefined) ?? [];
}
function cursor(): number | undefined {
  return kv.get(`loop:${LOOP_ID}:cursor`) as number | undefined;
}

// ── the flow ────────────────────────────────────────────────────────

describe("seo-watcher full flow (real primitive + injected endpoint + llm)", () => {
  test("registration stamps untrustedInput (contentTrust classification)", () => {
    expect(_getRegisteredLoop(LOOP_ID)?.untrustedInput).toBe(true);
  });

  test("manual fire → check trips → drafts + parks a proposal; cursor advances", async () => {
    const report = await fireManual();
    expect(report.skipped).toBeUndefined();
    expect(report.status).toBe("awaiting_approval");
    const runId = report.runId!;
    const run = runOf(runId)!;
    expect(run.status).toBe("awaiting_approval");
    expect(run.proposal?.kind).toBe("artifact");
    // run id === fire id → the proposal ref matches the artifact path.
    expect(run.proposal?.ref).toBe(`recommendations/${runId}.md`);
    // The baseline advanced to the first reading (at-most-once).
    expect(cursor()).toBe(3);
    // A pending approval nudge was emitted.
    expect(events.pending.length).toBe(1);
  });

  test("unchanged reading on a second fire → the check skips (no new proposal)", async () => {
    await fireManual(); // baseline := 3
    const second = await fireManual(); // same body → unchanged
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("unchanged");
    // Still exactly one run parked.
    const ids = kv.get(`loop:${LOOP_ID}:index`) as string[];
    expect(ids.length).toBe(1);
  });

  test("approve → publishes the recommendation + label with HOST-STAMPED decidedBy", async () => {
    const runId = (await fireManual()).runId!;
    expect(runOf(runId)?.status).toBe("awaiting_approval");

    // Dashboard Approve row action — `userId` is the HOST-STAMPED identity.
    await handleApproveAction({ source: "hub", pageId: "dashboard", userId: "user-42", payload: { runId } });

    const run = runOf(runId)!;
    expect(run.status).toBe("approved");
    expect((run.outcome as SeoOutcome).published).toBe(true);
    expect((run.outcome as SeoOutcome).recommendation).toContain("Refresh the landing copy");

    const ls = labels();
    expect(ls.length).toBe(1);
    expect(ls[0]).toMatchObject({ decision: "approved", decidedBy: "user-42", loopConfigVersion: "1" });
    expect(events.resolved.length).toBe(1);
  });

  test("decline → discards + declined label with decidedBy + note", async () => {
    const runId = (await fireManual()).runId!;
    await handleDeclineAction({
      source: "hub",
      pageId: "dashboard",
      userId: "user-99",
      payload: { runId, note: "seasonal, ignore" },
    });

    const run = runOf(runId)!;
    expect(run.status).toBe("declined");
    // Nothing was published (discard, not finalize).
    expect((run.outcome as SeoOutcome | undefined)?.published).toBeUndefined();
    const ls = labels();
    expect(ls.length).toBe(1);
    expect(ls[0]).toMatchObject({ decision: "declined", decidedBy: "user-99", note: "seasonal, ignore" });
  });

  test("lost finalize closure (restart) → verifyManually, NO publish, NO label", async () => {
    const runId = (await fireManual()).runId!;
    expect(runOf(runId)?.status).toBe("awaiting_approval");

    // Simulate a subprocess restart: the in-memory finalize closure is gone,
    // but the parked run survives in Storage.
    _setProposalClosuresForTests(LOOP_ID, runId, null);

    await handleApproveAction({ source: "hub", pageId: "dashboard", userId: "user-42", payload: { runId } });

    const run = runOf(runId)!;
    // Never re-invokes finalize: flagged for manual verification, no publish.
    expect(run.verifyManually).toBe(true);
    expect((run.outcome as SeoOutcome | undefined)?.published).toBeUndefined();
    // No label appended (the decision could not be safely finalized).
    expect(labels().length).toBe(0);
  });

  test("moved-past-threshold across fires advances the baseline each real move", async () => {
    // First fire → baseline 3, approve to clear the parked run.
    const r1 = (await fireManual()).runId!;
    await handleApproveAction({ source: "hub", pageId: "dashboard", userId: "u1", payload: { runId: r1 } });
    expect(cursor()).toBe(3);

    // The endpoint reports a new reading → a real move → a fresh proposal.
    endpointBody = JSON.stringify({ data: { rank: 8 } });
    const r2 = (await fireManual()).runId!;
    expect(r2).not.toBe(r1);
    expect(runOf(r2)?.status).toBe("awaiting_approval");
    expect(cursor()).toBe(8);
  });
});
