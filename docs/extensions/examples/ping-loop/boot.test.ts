// ping-loop — boot-path + log-mapper unit coverage.
//
// The full primitive path (page action → fire → run → artifact write →
// dashboard push) runs in the live app, but a spawned subprocess's coverage
// isn't collected into this process's lcov, so the production-boot `start()`
// body and the inline `log.artifact` callback + dashboard wiring would show
// uncovered. This isolated file drives them IN-process:
//   - `start()` is called directly (channel/dispatcher are real but the read
//     loop is fire-and-forget + reset after), covering the boot body.
//   - `defineLoop` is captured via a delegating module stub so the
//     `log.artifact` mapper + `log.dashboard` (render + rowActions) can be
//     invoked + asserted directly — without touching the real loop registry.

import { test, expect, describe, afterEach, mock } from "bun:test";
import type { LoopRunState } from "@ezcorp/sdk/runtime";
import type { PingOutcome } from "./index";

// Delegating stub: keep every real `@ezcorp/sdk/runtime` export, override ONLY
// `defineLoop` to CAPTURE the loop definition. Installed BEFORE importing
// ./index so the module binds the stubbed symbol.
interface CapturedDef {
  id?: string;
  trigger?: { kind: string; tool?: string; pageAction?: string };
  contract?: { scope?: string; states?: readonly string[] };
  log?: {
    artifact?: (
      run: LoopRunState<PingOutcome>,
      outcome: PingOutcome,
    ) => { path: string; body: string } | null;
    dashboard?: {
      pageId: string;
      render: (runs: LoopRunState<PingOutcome>[]) => { build: () => { title: string; nodes: unknown[] } };
      rowActions?: Record<string, (e: unknown) => unknown>;
    };
  };
}
let capturedDef: CapturedDef | undefined;
const real = await import("@ezcorp/sdk/runtime");
mock.module("@ezcorp/sdk/runtime", () => ({
  ...real,
  defineLoop: (def: CapturedDef) => {
    capturedDef = def;
  },
}));

const { start, definePingLoop, PING_EVENT, PING_TOOL, PAGE_ID } = await import("./index");

afterEach(() => {
  // `defineLoop` is stubbed to merely CAPTURE; only the channel needs
  // resetting between tests.
  real.__resetChannelForTests();
  capturedDef = undefined;
});

function makeRun(id: string, message: string): LoopRunState<PingOutcome> {
  return {
    id,
    loopId: "ping",
    scope: "global",
    status: "done",
    events: [],
    outcome: { seq: 0, firedAt: "2026-06-24T00:00:00.000Z", message },
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

describe("definePingLoop (captured shape)", () => {
  test("declares a manual trigger (tool + pageAction) on a global, done loop", () => {
    definePingLoop();
    expect(capturedDef?.id).toBe("ping");
    expect(capturedDef?.trigger).toEqual({
      kind: "manual",
      tool: PING_TOOL,
      pageAction: PING_EVENT,
    });
    expect(capturedDef?.contract?.scope).toBe("global");
    expect(capturedDef?.contract?.states).toEqual(["done"]);
  });

  test("log.artifact maps a terminal run + outcome to the mirror file", () => {
    definePingLoop();
    const artifact = capturedDef?.log?.artifact;
    expect(typeof artifact).toBe("function");
    const out = artifact!(makeRun("run-42", "pong #5"), {
      seq: 5,
      firedAt: "2026-06-24T09:00:00.000Z",
      message: "pong #5",
    });
    expect(out).toEqual({
      path: "pings/run-42.md",
      body: "# Ping\n\npong #5\n\nfiredAt: 2026-06-24T09:00:00.000Z\n",
    });
  });

  test("log.dashboard render + rowActions wire the page + the ping-loop:run action", () => {
    definePingLoop();
    const dash = capturedDef?.log?.dashboard;
    expect(dash?.pageId).toBe(PAGE_ID);
    // The captured render is the exported renderPingDashboard — building it
    // yields the titled page with the Ping-now button.
    const tree = dash!.render([makeRun("r1", "pong #0")]).build();
    expect(tree.title).toBe("Ping Loop");
    expect(
      tree.nodes.some(
        (n) => (n as { type?: string; label?: string }).label === "Ping now",
      ),
    ).toBe(true);
    // The page action that fires the loop is wired in rowActions.
    expect(typeof dash?.rowActions?.[PING_EVENT]).toBe("function");
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    // Prime the real channel-side dispatcher first. In production the real
    // `defineLoop` touches `getChannel()` before `createToolDispatcher`; our
    // stub skips that, so prime it explicitly to mirror the booted state.
    real.getChannel();
    // `start()` calls the (stubbed) defineLoop, then the REAL
    // createToolDispatcher + getChannel().start() — non-blocking; the read
    // loop is fire-and-forget and reset in afterEach.
    expect(() => start()).not.toThrow();
    // The stubbed defineLoop captured the example's loop definition.
    expect(capturedDef?.log?.dashboard?.pageId).toBe(PAGE_ID);
  });
});
