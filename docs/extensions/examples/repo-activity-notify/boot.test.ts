// repo-activity-notify — boot-path + artifact-mirror unit coverage.
//
// The full trigger → check → act path is proven by the REAL-subprocess
// integration test, but a spawned subprocess's coverage isn't collected into
// this process's lcov, so the production-boot `start()` body and the inline
// `log.artifact` callback show as uncovered there. This isolated file drives
// both IN-process against the SDK test channel (mirrors sample-loop/boot.test.ts):
//   - `start()` is called directly (channel/dispatcher real but the read loop
//     is fire-and-forget + reset after), covering the boot body.
//   - `defineLoop` is captured via a delegating module stub so the
//     `log.artifact` mapper can be invoked + asserted directly.
import { test, expect, describe, afterEach, mock } from "bun:test";

// Delegating stub: keep every real `@ezcorp/sdk/runtime` export, override ONLY
// `defineLoop` to capture the loop definition the example registers. Must be
// installed BEFORE importing ./index so the module binds the stubbed symbol.
let capturedDef:
  | { log?: { artifact?: (run: { id: string }, outcome: { notice: string }) => { path: string; body: string } } }
  | undefined;
const real = await import("@ezcorp/sdk/runtime");
mock.module("@ezcorp/sdk/runtime", () => ({
  ...real,
  defineLoop: (def: typeof capturedDef) => {
    capturedDef = def;
  },
}));

const { start, defineRepoActivityNotifyLoop } = await import("./index");

afterEach(() => {
  // `defineLoop` is stubbed to merely CAPTURE (it never touches the real loop
  // registry), so only the channel needs resetting between tests.
  real.__resetChannelForTests();
  capturedDef = undefined;
});

describe("log.artifact mirror", () => {
  test("maps a terminal run + outcome to the human-readable notice artifact", () => {
    defineRepoActivityNotifyLoop();
    const artifact = capturedDef?.log?.artifact;
    expect(typeof artifact).toBe("function");
    const out = artifact!(
      { id: "run-7" },
      { notice: "repo-activity-notify: new commit abcdef12 — feat: x" },
    );
    expect(out).toEqual({
      path: "notices/run-7.md",
      body: "# Repo activity notice\n\nrepo-activity-notify: new commit abcdef12 — feat: x\n",
    });
  });
});

describe("start (production boot)", () => {
  test("registers the loop + mounts the dispatcher + starts the channel", () => {
    // Prime the real channel-side dispatcher register (production's real
    // defineLoop touches getChannel() before createToolDispatcher; our stub
    // skips that, so mirror the booted state explicitly).
    real.getChannel();
    // `start()` calls the (stubbed) defineLoop, then the REAL
    // createToolDispatcher + getChannel().start() — non-blocking; the read
    // loop is fire-and-forget and reset in afterEach.
    expect(() => start()).not.toThrow();
    expect(capturedDef?.log?.artifact).toBeDefined();
  });
});
