// ez-code — focused coverage for the loop-store-backed RunStore adapter.
//
// `index.test.ts` already exercises the create/update paths of the real
// `loopBackedRunStore` (the "production loop-store round-trip" test), but its
// 78-test suite leaves the adapter's `list()` / `get()` BODIES unattributed
// under Bun's coverage instrumentation (a known per-line attribution drift
// that surfaces only in large single-file suites). This SMALL, isolated file
// drives the same real adapter — `createLoopRunStore`-backed, NOT the
// in-memory test seam — through the public tool handlers so the `list()` and
// `get()` adapter bodies + the `toRunRecord` mapping are cleanly covered.
// The coverage pipeline runs each test file in its own bun process and
// SUMS DA hits per (file,line) across shards (scripts/merge-lcov.ts), so these
// hits merge into the whole-repo lcov the patch-coverage gate reads.
import { afterEach, describe, expect, test } from "bun:test";
import { __resetChannelForTests, getChannel, type HostChannel } from "@ezcorp/sdk/runtime";
import {
  dispatchRun,
  listRuns,
  steerRunById,
  _setAppendMessageForTests,
  _setGlobalStoreForTests,
  _setMemoryForTests,
  _setPushPageForTests,
  _setSpawnForTests,
  _setTaskStoreForTests,
  _setUserStoreForTests,
} from "./index";
import type { ToolCallResult } from "../../../../src/extensions/types";

function parse(result: ToolCallResult): { runs: Array<{ id: string; title: string; agentName: string; status: string }> } {
  const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return JSON.parse(text!.text);
}

/**
 * Wire a scope-keyed in-memory Storage onto the host channel and force the
 * PRODUCTION loop-store-backed stores (the `null` seam), so `dispatch_run`,
 * `list_runs`, and `steerRunById` all round-trip through the real
 * `createLoopRunStore` + the `loopBackedRunStore` adapter.
 */
function wireRealStore(): void {
  const saved: Record<string, unknown> = {};
  const skey = (p: Record<string, unknown>) => `${p.scope}:${p.key}`;
  const ch = getChannel();
  const originalRequest = ch.request.bind(ch);
  ch.request = (async (method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    if (method === "ezcorp/storage") {
      const k = skey(p);
      if (p.action === "set") {
        saved[k] = p.value;
        return { ok: true };
      }
      if (p.action === "delete") {
        delete saved[k];
        return { deleted: true };
      }
      return { value: saved[k] ?? null, exists: k in saved };
    }
    if (method === "ezcorp/spawn-assignment") {
      return { v: 1, subConversationId: "s1", agentRunId: "run-ls", taskId: "t1", assignmentId: "a1" };
    }
    return originalRequest(method, params as never);
  }) as HostChannel["request"];

  // `null` → recreate the production loop-store-backed stores on next access.
  _setUserStoreForTests(null);
  _setGlobalStoreForTests(null);
  _setSpawnForTests(null);
  _setMemoryForTests(async () => []);
  _setTaskStoreForTests({ read: async () => [], write: async () => {} });
  _setPushPageForTests(() => {});
  // steer_run appends a turn into the run's sub-conversation; stub it so the
  // store.get() path under test isn't gated on a real appendMessage RPC.
  _setAppendMessageForTests(async () => {});
}

afterEach(() => {
  __resetChannelForTests();
  _setUserStoreForTests(null);
  _setGlobalStoreForTests(null);
  _setSpawnForTests(null);
  _setAppendMessageForTests(null);
});

describe("loopBackedRunStore adapter (real loop-store)", () => {
  test("list() maps every stored run through toRunRecord (newest-first)", async () => {
    wireRealStore();
    await dispatchRun({ agentName: "Custom Bot", task: "do it", title: "RT" });

    const listed = parse(await listRuns({}));
    expect(listed.runs.map((r) => r.id)).toEqual(["run-ls"]);
    expect(listed.runs[0]!.title).toBe("RT");
    expect(listed.runs[0]!.agentName).toBe("Custom Bot");
    expect(listed.runs[0]!.status).toBe("dispatched");
  });

  test("get() returns the mapped run for a known id, null for an unknown id", async () => {
    wireRealStore();
    await dispatchRun({ agentName: "Custom Bot", task: "do it", title: "RT" });

    // steerRunById() reads the run via the adapter's get() and acts only when
    // the run exists AND is live — covering both the hit (toRunRecord) branch
    // and the absent (null) branch of get().
    const hit = await steerRunById("run-ls", "keep going");
    expect(hit.ok).toBe(true);

    const miss = await steerRunById("does-not-exist", "noop");
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain("no run with id");
  });
});
