// ping-loop — `firePing` + default run-store wiring coverage.
//
// `firePing` (the `ping-loop:run` page-action handler) computes the next seq from
// the current run count and fires the loop's manual tool. Exercising it for
// real needs the registered tool handler + a live Storage channel — neither
// available in a unit test — so this file uses a delegating module stub
// (keep every real `@ezcorp/sdk/runtime` export, override ONLY `getLoopTools`
// + `createLoopRunStore`) to:
//   - capture the args the loop tool is fired with (assert seq = run count),
//   - cover the no-tool-registered no-op branch,
//   - cover the DEFAULT run-lister (`createLoopRunStore(...).list()`), which
//     the pure-function suite stubs past.
// The stub MUST be installed BEFORE importing ./index so the module binds the
// stubbed symbols.

import { test, expect, describe, afterEach, mock } from "bun:test";
import type { LoopRunState, PageActionEvent } from "@ezcorp/sdk/runtime";

// Mutable test seams the delegating stub reads.
let capturedFire: Array<Record<string, unknown>> = [];
let toolMap: Record<string, (args: Record<string, unknown>) => unknown> = {};
let storeRuns: LoopRunState[] = [];

const real = await import("@ezcorp/sdk/runtime");
mock.module("@ezcorp/sdk/runtime", () => ({
  ...real,
  // Return whatever the current test installed (a capturing tool, or {}).
  getLoopTools: () => toolMap,
  // A minimal fake store whose `list()` yields the test's `storeRuns`, so the
  // default run-lister body runs without a live Storage channel.
  createLoopRunStore: () => ({ list: async () => storeRuns }),
}));

const { firePing, _setRunListerForTests, PING_TOOL, PAGE_ID } = await import("./index");

const EVT: PageActionEvent = {
  source: "hub",
  pageId: PAGE_ID,
  userId: "u1",
};

function makeRun(id: string): LoopRunState {
  return {
    id,
    loopId: "ping",
    scope: "global",
    status: "done",
    events: [],
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

afterEach(() => {
  capturedFire = [];
  toolMap = {};
  storeRuns = [];
  _setRunListerForTests(null);
});

describe("firePing", () => {
  test("fires the loop tool with seq = current run count (overridden lister)", async () => {
    toolMap = {
      [PING_TOOL]: (args) => {
        capturedFire.push(args);
        return { ok: true };
      },
    };
    _setRunListerForTests(async () => [makeRun("r1"), makeRun("r2"), makeRun("r3")]);
    await firePing(EVT);
    expect(capturedFire).toEqual([{ seq: 3 }]);
  });

  test("seq comes from the DEFAULT run-store lister when not overridden", async () => {
    toolMap = {
      [PING_TOOL]: (args) => {
        capturedFire.push(args);
        return { ok: true };
      },
    };
    // No `_setRunListerForTests` → firePing uses `defaultRunLister`, which
    // reads the (stubbed) createLoopRunStore().list().
    storeRuns = [makeRun("a"), makeRun("b")];
    await firePing(EVT);
    expect(capturedFire).toEqual([{ seq: 2 }]);
  });

  test("no registered tool → no-op (does not throw)", async () => {
    toolMap = {}; // ping_run absent
    _setRunListerForTests(async () => [makeRun("r1")]);
    await expect(firePing(EVT)).resolves.toBeUndefined();
    expect(capturedFire).toEqual([]);
  });
});
