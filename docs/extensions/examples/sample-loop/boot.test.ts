// sample-loop — boot-path + artifact-mirror unit coverage.
//
// The full primitive path (event → run → artifact write) is proven by the
// REAL-subprocess integration test (index.integration.test.ts / try-loop),
// but a spawned subprocess's coverage isn't collected into this process's
// lcov, so the production-boot `start()` body and the inline `log.artifact`
// callback show as uncovered there. This isolated file drives both IN-process
// against the SDK test channel:
//   - `start()` is called directly (channel/dispatcher are real but the read
//     loop is fire-and-forget + reset after), covering the boot body.
//   - `defineLoop` is captured via a delegating module stub so the
//     `log.artifact` mapper can be invoked + asserted directly.
import { test, expect, describe, afterEach, mock } from "bun:test";

// Delegating stub: keep every real `@ezcorp/sdk/runtime` export, override ONLY
// `defineLoop` to capture the loop definition the example registers. Must be
// installed BEFORE importing ./index so the module binds the stubbed symbol.
let capturedDef: { log?: { artifact?: (run: { id: string }, outcome: { summary: string }) => { path: string; body: string } } } | undefined;
const real = await import("@ezcorp/sdk/runtime");
mock.module("@ezcorp/sdk/runtime", () => ({
  ...real,
  defineLoop: (def: typeof capturedDef) => {
    capturedDef = def;
  },
}));

const { start, defineSampleLoop } = await import("./index");

afterEach(() => {
  // `defineLoop` is stubbed to merely CAPTURE (it never touches the real loop
  // registry), so only the channel needs resetting between tests.
  real.__resetChannelForTests();
  capturedDef = undefined;
});

describe("log.artifact mirror", () => {
  test("maps a terminal run + outcome to the human-readable artifact file", () => {
    defineSampleLoop();
    const artifact = capturedDef?.log?.artifact;
    expect(typeof artifact).toBe("function");
    const out = artifact!({ id: "run-42" }, { summary: "Discussed key rotation." });
    expect(out).toEqual({
      path: "summaries/run-42.md",
      body: "# Summary\n\nDiscussed key rotation.\n",
    });
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    // Arm the real channel-side dispatcher register first. In production the
    // real `defineLoop` touches `getChannel()` (which calls
    // `ensureDispatcherRegistered()`) before `createToolDispatcher` runs; our
    // `defineLoop` stub skips that, so prime it explicitly via `getChannel()`
    // to mirror the booted state.
    real.getChannel();
    // `start()` calls the (stubbed) defineLoop, then the REAL
    // createToolDispatcher + getChannel().start() — non-blocking; the read
    // loop is fire-and-forget and reset in afterEach.
    expect(() => start()).not.toThrow();
    // The stubbed defineLoop captured the example's loop definition.
    expect(capturedDef?.log?.artifact).toBeDefined();
  });
});
