// webhook-ticket-loop — boot-path + artifact-mirror unit coverage.
//
// A spawned subprocess's coverage isn't collected into this process's lcov, so
// the production-boot `start()` body and the inline `log.artifact` callback
// show as uncovered in the integration test. This isolated file drives both
// IN-process against the SDK test channel (mirrors sample-loop/boot.test.ts):
//   - `defineLoop` is captured via a delegating module stub so the
//     `log.artifact` mapper can be invoked + asserted directly.
//   - `start()` is called directly, covering the boot body.
import { test, expect, describe, afterEach, mock } from "bun:test";

interface CapturedDef {
  log?: {
    artifact?: (
      run: { id: string },
      outcome: { ticketId: string; priority: string; deliveryId: string },
    ) => { path: string; body: string };
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

const { start, defineWebhookLoop } = await import("./index");

afterEach(() => {
  real.__resetChannelForTests();
  capturedDef = undefined;
});

describe("log.artifact mirror", () => {
  test("maps a terminal run + outcome to the human-readable artifact file", () => {
    defineWebhookLoop();
    const artifact = capturedDef?.log?.artifact;
    expect(typeof artifact).toBe("function");
    const out = artifact!({ id: "run-7" }, { ticketId: "T7", priority: "high", deliveryId: "del-7" });
    expect(out).toEqual({
      path: "tickets/run-7.md",
      body: "# Ticket T7\n\nPriority: high\nDelivery: del-7\n",
    });
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    real.getChannel();
    expect(() => start()).not.toThrow();
    expect(capturedDef?.log?.artifact).toBeDefined();
  });
});
